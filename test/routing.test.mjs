import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buffer } from 'node:stream/consumers';
import { addAccount, accountRoot, selectedAccount } from '../src/accounts.mjs';
import { ensureState, writePrivate } from '../src/state.mjs';
import { createRouter, weeklyWindow } from '../src/routing.mjs';
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
  assert.deepEqual(router.status(), { mode: 'automatic', weekly_reserve_percent: 5, allow_reserve_usage: false, state: 'ready', account: second.id });
  readings.set(root, limits(100));
  readings.set(paths[1], limits(6));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1', 'do not bounce back when an earlier account resets');
  readings.set(paths[1], limits(5));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0', 'wrap back to a replenished account when the current one reaches reserve');
}));

test('new requests switch while an existing stream keeps its original credentials and bytes', () => fixture(async ({ root, readings, router }) => {
  await router.refresh();
  const began = Promise.withResolvers(), held = Promise.withResolvers();
  const seen = [], bytes = gzipSync(JSON.stringify({ model: 'fixture', stream: true,
    input: [{ type: 'reasoning', encrypted_content: 'opaque-fixture' }],
  }));
  const server = await startServer({ port: 0, credentials: router.credentials, routingStatus: router.status,
    transport: async (_url, options) => {
      seen.push({ token: options.headers.get('authorization'), account: options.headers.get('chatgpt-account-id') });
      assert.deepEqual(await buffer(options.body), bytes);
      assert.equal(options.headers.get('x-codex-turn-state'), 'opaque-turn-fixture');
      if (seen.length === 1) {
        began.resolve();
        await held.promise;
      }
      return new Response('unchanged-response', { headers: { 'x-codex-turn-state': 'returned-fixture' } });
    } });
  const request = () => fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: 'POST',
    headers: { 'content-encoding': 'gzip', 'x-codex-turn-state': 'opaque-turn-fixture' }, body: bytes,
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
      assert.equal(response.headers.get('x-codex-turn-state'), 'returned-fixture');
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

test('usage failures keep forwarding after cache expiry and expose only safe diagnostics', () => fixture(async ({ paths, readings, router, advance }) => {
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
}));

test('missing weekly data keeps the selected signed-in account usable; missing login still blocks', () => fixture(async ({ root, paths, readings, router }) => {
  readings.set(root, { buckets: [{ id: 'codex', primary: { remaining_percent: 99, window_minutes: 300 } }] });
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  assert.equal(router.status().state, 'usage_degraded');
  await rm(join(paths[1], 'codex', 'auth.json'));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  assert.equal(weeklyWindow({ buckets: [
    { id: 'images', primary: { remaining_percent: 100, window_minutes: 10080 } }, { id: 'codex', primary: null },
  ] }), null);
  await rm(join(root, 'codex', 'auth.json'));
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'login_required' });
}));

test('cold-start requests and client retries never wait for usage or start more usage workers', () => fixture(async ({ root }) => {
  const began = Promise.withResolvers();
  let reads = 0, forwards = 0;
  const router = createRouter({ root, usage: async (_path, { signal }) => {
    reads++;
    began.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  const server = await startServer({ port: 0, credentials: router.credentials, transport: async () => {
    forwards++; return new Response('fixture');
  } });
  try {
    void router.refresh();
    await began.promise;
    for (let i = 0; i < 4; i++) {
      const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, { method: 'POST',
        body: JSON.stringify({ model: 'fixture', stream: true }), signal: AbortSignal.timeout(1000) });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal(forwards, 4);
    assert.equal(reads, 2);
    assert.equal(router.status().state, 'usage_degraded');
  } finally { await server.close(); await router.close(); }
}));

test('empty and expired usage reports preserve valid snapshots and confirmed reserves', () => fixture(async ({ paths, readings, router, advance }) => {
  await router.refresh();
  advance(1000);
  for (const path of paths) readings.set(path, { buckets: [] });
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  assert.equal((await router.usageStatus()).accounts[0].buckets[0].secondary.remaining_percent, 80);
  assert.equal((await router.usageStatus()).accounts[0].diagnostics.last_error, 'missing_weekly_window');
  for (const path of paths) readings.set(path, limits(5));
  await router.refresh();
  advance(600_000);
  for (const path of paths) readings.set(path, limits(100, 120));
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'weekly_reserve_reached' });
  assert.equal((await router.usageStatus()).accounts[0].diagnostics.last_error, 'stale_response');
  for (const path of paths) readings.set(path, { buckets: [] });
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'weekly_reserve_reached' });
  readings.set(paths[1], limits(80));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1');
  assert.equal(router.status().state, 'ready');
  assert.equal((await router.usageStatus()).accounts[1].diagnostics.consecutive_failures, 0);
}));

test('a confirmed reserve can switch to an account with unknown usage, including manual selection', () => fixture(async ({ root, second, paths, readings, router }) => {
  readings.set(root, limits(5));
  readings.set(paths[1], new Error('private failure'));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1');
  assert.equal(router.status().state, 'usage_degraded');
  await router.select(second.id);
  assert.equal((await router.credentials()).account, 'fixture-account-1');
}));

test('repeated failed background checks back off, and requests do not change the schedule', () => fixture(async ({ paths, readings, router }) => {
  for (const path of paths) readings.set(path, Object.assign(new Error('private timeout'), { code: 'usage_timeout' }));
  const scheduled = [];
  for (let i = 0; i < 4; i++) {
    await router.refresh();
    const status = await router.usageStatus();
    scheduled.push(Date.parse(status.next_check_at) - Date.parse(status.accounts[0].diagnostics.last_attempt_at));
    assert.equal(status.accounts[0].diagnostics.last_error, 'timeout');
    assert.equal(status.accounts[0].diagnostics.consecutive_failures, i + 1);
    await router.credentials();
    assert.equal((await router.usageStatus()).next_check_at, status.next_check_at);
  }
  assert.deepEqual(scheduled, [60_000, 120_000, 240_000, 300_000]);
}));

test('manual selection cannot bypass the weekly reserve', () => fixture(async ({ root, second, readings, router }) => {
  readings.set(root, limits(0));
  await router.refresh();
  await router.select('default');
  assert.equal((await selectedAccount(root)).id, 'default');
  await router.credentials();
  assert.equal((await selectedAccount(root)).id, second.id);
}));

test('background refresh is coalesced, polls without clients, and stops its usage workers on shutdown', () => fixture(async ({ root }) => {
  const secondCheck = Promise.withResolvers();
  let calls = 0, aborted = 0;
  const router = createRouter({ root, intervalMs: 10, usage: async (_path, { signal }) => {
    calls++;
    if (calls <= 2) return limits(80);
    secondCheck.resolve();
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
      aborted++; reject(new Error('cancelled'));
    }, { once: true }));
  } });
  try {
    await Promise.all([router.refresh(), router.refresh()]);
    assert.equal(calls, 2);
    // Keep the test's event loop alive while the production timer is unref'ed.
    const deadline = setTimeout(() => secondCheck.reject(new Error('poll did not run')), 5000);
    try { await secondCheck.promise; } finally { clearTimeout(deadline); }
    await router.close();
    assert.equal(aborted, 2);
    assert.equal(calls, 4);
  } finally { await router.close(); }
}));

test('reserve opt-in resumes immediately, prefers replenished accounts, and can pause again', () => fixture(async ({ root, paths, readings, router }) => {
  for (const path of paths) readings.set(path, limits(5));
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'weekly_reserve_reached' });
  await router.setAllowReserveUsage(true);
  assert.equal(router.status().state, 'ready');
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  readings.set(root, limits(0));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1', 'reserve permission cannot bypass an exhausted allowance');
  readings.set(paths[1], limits(90));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1');
  readings.set(paths[1], limits(1));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1');
  await router.setAllowReserveUsage(false);
  assert.equal(router.status().state, 'usage_limit_reached');
  await assert.rejects(router.credentials(), { code: 'usage_limit_reached' });
}));

test('reserve control authenticates, leaves active requests intact, and forwards upstream limits once', () => fixture(async ({ paths, readings, router }) => {
  for (const path of paths) readings.set(path, limits(2));
  await router.refresh();
  const began = Promise.withResolvers(), held = Promise.withResolvers();
  let calls = 0;
  const server = await startServer({ port: 0, credentials: router.credentials, controlToken: 'fixture-control',
    routingStatus: router.status, setReserveUsage: router.setAllowReserveUsage,
    transport: async () => { calls++; began.resolve(); await held.promise; return new Response('quota-limit', { status: 429 }); } });
  const base = `http://127.0.0.1:${server.port}`;
  const control = (enabled, token) => fetch(`${base}/control/reserve-usage/${enabled}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  let pending;
  try {
    assert.equal((await control(true, 'wrong')).status, 403);
    assert.equal(router.status().allow_reserve_usage, false);
    assert.equal((await control(true, 'fixture-control')).status, 200);
    pending = fetch(`${base}/v1/responses`, { method: 'POST', body: '{}' });
    await began.promise;
    assert.equal((await control(false, 'fixture-control')).status, 200);
    const blocked = await fetch(`${base}/v1/responses`, { method: 'POST', body: '{}' });
    assert.equal(blocked.status, 503);
    held.resolve();
    const result = await pending;
    assert.equal(result.status, 429);
    assert.equal(await result.text(), 'quota-limit');
    assert.equal(calls, 1);
  } finally { held.resolve(); await pending; await server.close(); }
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

test('short-window exhaustion switches accounts even when weekly allowance remains', () => fixture(async ({ root, paths, readings, router }) => {
  const shortLimit = credited(90);
  shortLimit.buckets[0].primary.remaining_percent = 0;
  readings.set(root, shortLimit);
  await router.setCreditFallback('default', true);
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1');
  readings.set(paths[1], limits(0));
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  assert.equal(router.status().state, 'credit_fallback');
  await router.setCreditFallback('default', false);
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

test('credit control authenticates and disabling it neither interrupts nor replays an active request', () => fixture(async ({ paths, readings, router }) => {
  for (const path of paths) readings.set(path, credited(0));
  await router.refresh();
  const began = Promise.withResolvers(), held = Promise.withResolvers();
  let calls = 0;
  const server = await startServer({ port: 0, credentials: router.credentials, controlToken: 'fixture-control',
    setCreditFallback: router.setCreditFallback,
    transport: async () => { calls++; began.resolve(); await held.promise; return new Response('unchanged', { status: 429 }); } });
  const base = `http://127.0.0.1:${server.port}`;
  const control = (enabled, token = 'fixture-control') => fetch(`${base}/control/credit-fallback/default/${enabled}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` },
  });
  let pending;
  try {
    assert.equal((await control(true, 'wrong')).status, 403);
    assert.equal((await control(true)).status, 200);
    pending = fetch(`${base}/v1/responses`, { method: 'POST', body: '{}' });
    await began.promise;
    assert.equal((await control(false)).status, 200);
    const blocked = await fetch(`${base}/v1/responses`, { method: 'POST', body: '{}' });
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).error.code, 'usage_limit_reached');
    held.resolve();
    const response = await pending;
    assert.equal(response.status, 429);
    assert.equal(await response.text(), 'unchanged');
    assert.equal(calls, 1);
  } finally { held.resolve(); await pending; await server.close(); }
}));
