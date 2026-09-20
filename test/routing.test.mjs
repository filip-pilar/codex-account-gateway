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
    await assert.rejects(router.credentials(), { code: 'usage_unavailable' });
    readings.set(root, limits(100, 604_921));
    await router.refresh();
    assert.equal((await router.credentials()).account, 'fixture-account-0');
  } finally { await server.close(); }
}));

test('usage failures have bounded stale tolerance and never expose upstream errors', () => fixture(async ({ paths, readings, router, advance }) => {
  await router.refresh();
  for (const path of paths) readings.set(path, new Error('private upstream detail'));
  advance(60_000);
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-0');
  advance(240_000);
  await assert.rejects(router.credentials(), error => error.code === 'usage_unavailable' && !error.message.includes('private'));
  assert.doesNotMatch(JSON.stringify(router.status()), /token|private upstream/);
}));

test('missing weekly data, ambiguous buckets, and unsigned-in accounts are not eligible', () => fixture(async ({ root, paths, readings, router }) => {
  readings.set(root, { buckets: [{ id: 'codex', primary: { remaining_percent: 99, window_minutes: 300 } }] });
  await router.refresh();
  assert.equal((await router.credentials()).account, 'fixture-account-1');
  await rm(join(paths[1], 'codex', 'auth.json'));
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'usage_unavailable' });
  assert.equal(weeklyWindow({ buckets: [
    { id: 'images', primary: { remaining_percent: 100, window_minutes: 10080 } }, { id: 'codex', primary: null },
  ] }), null);
  await rm(join(root, 'codex', 'auth.json'));
  await router.refresh();
  await assert.rejects(router.credentials(), { code: 'login_required' });
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
