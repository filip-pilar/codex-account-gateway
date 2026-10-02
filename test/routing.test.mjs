import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAccount, accountRoot, selectedAccount } from '../src/accounts.mjs';
import { ensureState, writePrivate } from '../src/state.mjs';
import { createRouter } from '../src/routing.mjs';
import { startServer } from '../src/server.mjs';

const limits = (remaining, reset = null) => ({ buckets: [{ id: 'codex',
  primary: { remaining_percent: 80, window_minutes: 300, resets_at: null },
  secondary: { remaining_percent: remaining, window_minutes: 10080, resets_at: reset },
}] });
const credited = (remaining, credits = { has_credits: true, unlimited: false, balance: 120 }) => {
  const result = limits(remaining);
  result.buckets[0].credits = credits;
  return result;
};
async function fixture(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gateway-routing-')));
  const second = await addAccount(root, 'Second');
  const paths = [root, accountRoot(root, second.id)];
  for (const [index, path] of paths.entries()) {
    const home = await ensureState(path);
    await writePrivate(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: {
      access_token: `fixture-token-${index}`, account_id: `fixture-account-${index}`,
    } }));
  }
  const readings = new Map(paths.map(path => [path, limits(80)]));
  let time = 100_000;
  const router = createRouter({ root, now: () => time, usage: async path => {
    const value = readings.get(path);
    if (value instanceof Error) throw value;
    return value;
  } });
  try { await fn({ root, second, paths, readings, router, advance: ms => time += ms }); }
  finally { await router.close(); await rm(root, { recursive: true, force: true }); }
}

test('weekly rotation keeps the current account above 5%, switches at 5%, and persists selection', () => fixture(async ({ root, second, paths, readings, router }) => {
  readings.set(root, limits(5.1));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  readings.set(root, limits(5));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1');
  assert.equal((await selectedAccount(root)).id, second.id);
  await router.select('default');
  assert.equal((await router.credentials()).account, 'fixture-account-1', 'manual selection cannot bypass the reserve');
  assert.deepEqual(router.status(), { mode: 'automatic', weekly_reserve_percent: 5, allow_reserve_usage: false, state: 'ready', account: second.id });
  readings.set(root, limits(100));
  readings.set(paths[1], limits(6));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1', 'do not bounce back when an earlier account resets');
  readings.set(paths[1], limits(5));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0', 'wrap back to a replenished account when the current one reaches reserve');
}));

test('new requests switch while an existing stream keeps its original account', () => fixture(async ({ root, readings, router }) => {
  await router.refresh();
  const began = Promise.withResolvers(), held = Promise.withResolvers();
  const seen = [];
  const server = await startServer({ port: 0, credentials: router.credentials, routingStatus: router.status,
    transport: async (_url, options) => {
      seen.push({ token: options.headers.get('authorization'), account: options.headers.get('chatgpt-account-id') });
      if (seen.length === 1) {
        began.resolve();
        await held.promise;
      }
      return new Response('unchanged-response');
    } });
  const request = () => fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(10000),
  });
  const first = request();
  try {
    await began.promise;
    readings.set(root, limits(4));
    await router.refresh();
    const later = await Promise.all([request(), request(), request()]);
    for (const response of later) {
      assert.equal(response.status, 200);
      assert.equal(await response.text(), 'unchanged-response');
    }
    held.resolve();
    assert.equal(await (await first).text(), 'unchanged-response');
    assert.deepEqual(seen, [
      { token: 'Bearer fixture-token-0', account: 'fixture-account-0' },
      ...Array.from({ length: 3 }, () => ({ token: 'Bearer fixture-token-1', account: 'fixture-account-1' })),
    ]);
  } finally { held.resolve(); await first.catch(() => {}); await server.close(); }
}));

test('all accounts at reserve block new requests, then recover only after a fresh reset reading', () => fixture(async ({ root, paths, readings, router, advance }) => {
  for (const path of paths) readings.set(path, limits(5, 120));
  await router.refresh();
  let calls = 0;
  const server = await startServer({ port: 0, credentials: router.credentials, transport: async () => {
    calls++; return new Response('ok');
  } });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
      method: 'POST', body: JSON.stringify({ model: 'fixture', stream: true }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.message, 'weekly_reserve_reached');
    assert.equal(calls, 0);
    advance(21_000);
    await assert.rejects(router.credentials(), { code: 'weekly_reserve_reached' });
    readings.set(root, limits(100, 604_921));
    await router.refresh();
    assert.equal((await router.credentials()).account, 'fixture-account-0');
  } finally { await server.close(); }
}));

test('usage failures keep forwarding after cache expiry and expose only safe diagnostics', () => fixture(async ({ root, paths, readings, router, advance }) => {
  await router.refresh();
  for (const path of paths) readings.set(path, new Error('private upstream detail'));
  advance(60_000);
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  advance(240_000);
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  assert.equal(router.status().state, 'usage_degraded');
  const status = await router.usageStatus();
  assert.equal(status.accounts[0].stale, true);
  assert.equal(status.accounts[0].diagnostics.consecutive_failures, 1);
  assert.equal(status.accounts[0].diagnostics.last_error, 'usage_unavailable');
  assert.ok(status.accounts[0].diagnostics.last_success_at);
  assert.doesNotMatch(JSON.stringify(status), /token|private upstream/);
  readings.set(root, limits(5));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1', 'an unknown account remains a fallback when the current account reaches reserve');
}));

test('credit fallback is per account, lower priority than included usage, and separate from reserve permission', () => fixture(async ({ root, second, paths, readings, router }) => {
  readings.set(root, credited(0));
  readings.set(paths[1], credited(0));
  await router.refresh();
  await router.setAllowReserveUsage(true);
  await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
  await router.setCreditFallback(second.id, true);
  assert.equal((await router.credentials()).account, 'fixture-account-1');
  assert.equal(router.status().state, 'credit_fallback');
  readings.set(root, limits(2));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0', 'included reserve wins over credit usage');
  await router.setAllowReserveUsage(false);
  assert.equal((await router.credentials()).account, 'fixture-account-1');
  readings.set(root, limits(70));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  await router.setCreditFallback(second.id, false);
  readings.set(root, limits(0));
  await router.refresh();
  await router.select(second.id);
  await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
}));

test('partial reports cannot hide or clear a confirmed short-window exhaustion', () => fixture(async ({ root, paths, readings, router }) => {
  await router.refresh();
  readings.set(paths[1], limits(0));
  readings.set(root, { buckets: [{ id: 'codex', primary: { remaining_percent: 0, window_minutes: 300 } }] });
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
  assert.equal((await router.usageStatus()).accounts[0].included_usage_exhausted, true);
  const partial = limits(90);
  partial.buckets[0].primary = null;
  readings.set(root, partial);
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
  readings.set(root, limits(90));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  assert.equal((await router.usageStatus()).accounts[0].included_usage_exhausted, false);
}));

test('fresh duration metadata clears provisional exhaustion in either window slot', async () => {
  for (const slot of ['primary', 'secondary']) await fixture(async ({ root, paths, readings, router }) => {
    readings.set(paths[1], limits(0));
    const initial = limits(90);
    initial.buckets[0][slot] = { remaining_percent: 0, window_minutes: null, resets_at: null };
    readings.set(root, initial);
    await router.refresh();
    await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
    assert.equal((await router.usageStatus()).accounts[0].included_usage_exhausted, true);

    const stale = limits(90);
    stale.buckets[0][slot].resets_at = 99;
    readings.set(root, stale);
    await router.refresh();
    await assert.rejects(router.credentials(), { code: 'usage_limit_reached' }, 'an expired report cannot clear exhaustion');

    const stillExhausted = limits(90);
    stillExhausted.buckets[0][slot].remaining_percent = 0;
    readings.set(root, stillExhausted);
    await router.refresh();
    await assert.rejects(router.credentials(), { code: 'usage_limit_reached' }, 'duration metadata alone does not replenish usage');

    readings.set(root, limits(90));
    await router.refresh();
    assert.equal((await router.credentials()).account, 'fixture-account-0');
    assert.equal((await router.usageStatus()).accounts[0].included_usage_exhausted, false);
  });
});

test('fallback rejects missing, zero, failed, stale, and unrelated credits; replenishment resumes', () => fixture(async ({ root, paths, readings, router, advance }) => {
  readings.set(paths[1], limits(0));
  await router.setCreditFallback('default', true);
  for (const credits of [null, { has_credits: false, unlimited: false, balance: 10 }, { has_credits: true, unlimited: false, balance: 0 }]) {
    readings.set(root, credited(0, credits));
    await router.refresh();
    await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
  }
  const unrelated = credited(0, null);
  unrelated.buckets.push({ id: 'images', credits: { has_credits: true, unlimited: true, balance: null } });
  readings.set(root, unrelated);
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
  readings.set(root, credited(0, { has_credits: false, unlimited: true, balance: null }));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  readings.set(root, new Error('private failure'));
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
  readings.set(root, credited(0));
  await router.refresh();
  advance(300_000);
  await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  const expiredShort = credited(0);
  expiredShort.buckets[0].primary.resets_at = 399;
  readings.set(root, expiredShort);
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
}));
