import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { addAccount, accountRoot, selectedAccount } from '../src/accounts.mjs';
import { ensureState, writePrivate } from '../src/state.mjs';
import { createRouter, weeklyWindow } from '../src/routing.mjs';
import { startServer } from '../src/server.mjs';

const limits = (remaining, reset = null) => ({ buckets: [{ id: 'codex',
  primary: { remaining_percent: 0, window_minutes: 300, resets_at: null },
  secondary: { remaining_percent: remaining, window_minutes: 10080, resets_at: reset },
}] });
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
  assert.deepEqual(router.status(), { mode: 'automatic', weekly_reserve_percent: 5, state: 'ready', account: second.id });
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
      assert.deepEqual(options.body, bytes);
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
