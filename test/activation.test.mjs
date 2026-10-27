import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ensureState, writePrivate } from '../src/state.mjs';
import { addAccount, accountRoot, selectedAccount } from '../src/accounts.mjs';
import { createRouter } from '../src/routing.mjs';
import { activateWeeklyWindow, readActivationAttempt, writeActivationAttempt, readWeeklyActivation } from '../src/activation.mjs';

const week = 604800;
const window = (remaining, reset) => ({ remaining_percent: remaining, window_minutes: 10080, resets_at: reset });
const reading = (time, remaining = 100, reset = time / 1000 + week) => ({ checked_at: new Date(time).toISOString(), buckets: [{ id: 'codex', primary: window(remaining, reset), secondary: null }] });
async function fixture(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gateway-activation-')));
  const second = await addAccount(root, 'Second'), other = accountRoot(root, second.id);
  for (const [index, path] of [root, other].entries()) {
    await writePrivate(join(await ensureState(path), 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `fixture-secret-${index}`, account_id: `fixture-account-${index}` } }));
  }
  try { await fn({ root, other, second }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('activation defaults off; enabled checks activate once, verify, persist, and leave selection unchanged', () => fixture(async ({ root, other }) => {
  let time = 1800000000000, fixedReset = null, calls = 0;
  const requests = [];
  const defaultReset = time / 1000 + week;
  const usage = async path => reading(time, path === other && fixedReset != null ? 99 : 100, path === root ? defaultReset : fixedReset ?? time / 1000 + week);
  const activate = async path => {
    requests.push(path);
    assert.equal(path, other);
    assert.equal((await readActivationAttempt(path)).state, 'pending');
    calls++; fixedReset = time / 1000 + week;
  };
  let router = createRouter({ root, now: () => time, usage, activate });
  try {
    assert.equal(await readWeeklyActivation(root), false);
    await router.refresh(); time += 60000; await router.refresh(); assert.equal(calls, 0);
    assert.equal((await router.usageStatus()).accounts[1].weekly_window_state, 'appears_unstarted');
    await router.setWeeklyActivation(true);
    time += 60000; await Promise.all([router.refresh(), router.refresh()]);
    assert.deepEqual(requests, [other], 'a full account with a fixed reset must never activate');
    assert.equal(calls, 1); assert.equal((await selectedAccount(root)).id, 'default');
    assert.equal((await router.usageStatus()).accounts[1].activation.state, 'confirmed');
    assert.equal((await stat(join(other, 'weekly-activation-attempt.json'))).mode & 0o777, 0o600);
    await router.close();
    router = createRouter({ root, now: () => time, usage, activate, autoActivateWeeklyWindows: await readWeeklyActivation(root) });
    time += 60000; await router.refresh(); time += 60000; await router.refresh(); assert.equal(calls, 1);
    time = fixedReset * 1000 + 1000; fixedReset = null;
    await router.refresh(); time += 60000; await router.refresh(); assert.equal(calls, 2);
    assert.deepEqual(requests, [other, other]);
  } finally { await router.close(); }
}));

test('failed, interrupted, and unconfirmed attempts are never replayed by refresh or restart', () => fixture(async ({ root, other }) => {
  for (const outcome of ['failed', 'pending', 'unconfirmed']) {
    let time = 1800000000000, calls = 0;
    const usage = async path => path === root ? reading(time, 80) : reading(time);
    if (outcome === 'pending') await writeActivationAttempt(other, { state: 'pending', attempted_at: time, last_error: null });
    else await writeActivationAttempt(other, { state: 'confirmed', attempted_at: time - week * 1000, confirmed_reset_at: time / 1000 - 1, last_error: null });
    const activate = async () => { calls++; if (outcome === 'failed') throw new Error('private provider details'); };
    let router = createRouter({ root, now: () => time, usage, activate, autoActivateWeeklyWindows: true });
    try {
      await router.refresh(); time += 60000; await router.refresh(); time += 60000; await router.refresh();
      assert.equal(calls, outcome === 'pending' ? 0 : 1);
      const entry = (await router.usageStatus()).accounts[1];
      assert.equal(entry.activation.state, outcome === 'pending' ? 'unconfirmed' : outcome);
      assert.doesNotMatch(JSON.stringify(entry), /private provider|fixture-secret/);
      await router.close();
      router = createRouter({ root, now: () => time, usage, activate, autoActivateWeeklyWindows: true });
      time += 60000; await router.refresh(); time += 60000; await router.refresh();
      assert.equal(calls, outcome === 'pending' ? 0 : 1);
    } finally { await router.close(); }
  }
}));

test('disabling activation cancels an owned request; unsafe accounts never activate', () => fixture(async ({ root, other }) => {
  let time = 1800000000000, calls = 0;
  const began = Promise.withResolvers();
  const router = createRouter({ root, now: () => time, autoActivateWeeklyWindows: true,
    usage: async path => path === root ? reading(time, 80) : reading(time),
    activate: async (_path, { signal }) => { calls++; began.resolve(); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { category: 'cancelled' })), { once: true })); },
  });
  try {
    await router.refresh(); time += 60000; const refresh = router.refresh(); await began.promise;
    await router.setWeeklyActivation(false); await refresh;
    assert.equal((await readActivationAttempt(other)).last_error, 'cancelled'); assert.equal(calls, 1);
  } finally { await router.close(); }
  await writeFile(join(other, 'weekly-activation-attempt.json'), 'invalid', { mode: 0o600 });
  const unsafe = createRouter({ root, now: () => time, autoActivateWeeklyWindows: true,
    usage: async () => reading(time), activate: async () => calls++,
  });
  try {
    await unsafe.refresh(); time += 60000; await unsafe.refresh();
    assert.equal(calls, 2, 'only the safe default profile may activate');
    assert.equal((await unsafe.usageStatus()).accounts[1].activation.last_error, 'activation_state_unavailable');
  } finally { await unsafe.close(); }
}));

test('activation uses the intended credentials for one bounded tool-free request and redacts failures', () => fixture(async ({ other }) => {
  let calls = 0;
  const modelReader = async () => ({ model: 'fixture-model', effort: 'low' });
  const transport = async (url, options) => {
    calls++; assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(options.headers.get('authorization'), 'Bearer fixture-secret-1');
    assert.equal(options.headers.get('chatgpt-account-id'), 'fixture-account-1');
    let body = ''; for await (const chunk of options.body) body += chunk;
    const value = JSON.parse(body); assert.equal(value.store, false); assert.deepEqual(value.tools, []); assert.equal(value.tool_choice, 'none');
    return { status: 200, body: Readable.from(['data: {"type":"response.output_text.delta","delta":"private output"}\n\n', 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'].map(value => Buffer.from(value))) };
  };
  assert.equal(await activateWeeklyWindow(other, { modelReader, transport }), undefined); assert.equal(calls, 1);
  await assert.rejects(activateWeeklyWindow(other, { modelReader, transport: async () => { calls++; return { status: 429, body: Readable.from(['private rejection']) }; } }), error => error.category === 'upstream_rejected' && !error.message.includes('private'));
  assert.equal(calls, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(activateWeeklyWindow(other, { signal: controller.signal, modelReader, transport }), { category: 'cancelled' });
  assert.equal(calls, 2);
}));

test('activation skips short-window exhaustion and marks failed verification out of date', () => fixture(async ({ root, other }) => {
  let time = 1800000000000, calls = 0, verification = false;
  const router = createRouter({ root, now: () => time, autoActivateWeeklyWindows: true,
    usage: async path => {
      if (path === root) {
        const result = reading(time); result.buckets[0].secondary = { remaining_percent: 0, window_minutes: 300, resets_at: null }; return result;
      }
      if (verification) throw Object.assign(new Error('private error'), { category: 'timeout' });
      return reading(time);
    },
    activate: async () => { calls++; verification = true; },
  });
  try {
    await router.refresh(); time += 60000; await router.refresh();
    assert.equal(calls, 1);
    const status = await router.usageStatus();
    assert.equal(status.accounts[0].activation, null);
    assert.equal(status.accounts[1].stale, true);
    assert.equal(status.accounts[1].activation.last_error, 'verification_failed');
    verification = false; time += 60000; await router.refresh(); time += 60000; await router.refresh();
    assert.equal(calls, 1);
  } finally { await router.close(); }
}));

test('activation has a hard deadline and never retries after timeout or malformed output', () => fixture(async ({ root }) => {
  let calls = 0;
  const modelReader = async () => ({ model: 'fixture-model' });
  await assert.rejects(activateWeeklyWindow(root, { modelReader, timeoutMs: 50, transport: async (_url, { signal }) => {
    calls++; await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('private')), { once: true }));
  } }), { category: 'timeout' });
  await assert.rejects(activateWeeklyWindow(root, { modelReader, transport: async () => {
    calls++; return { status: 200, body: Readable.from([Buffer.from('data: invalid\n\n')]) };
  } }), { category: 'activation_failed' });
  assert.equal(calls, 2);
}));

test('expired short-window reports cannot authorize activation', () => fixture(async ({ root }) => {
  let time = 1800000000000, calls = 0;
  const router = createRouter({ root, now: () => time, autoActivateWeeklyWindows: true, activate: async () => calls++,
    usage: async () => {
      const result = reading(time); result.buckets[0].secondary = { remaining_percent: 100, window_minutes: 300, resets_at: time / 1000 - 1 }; return result;
    },
  });
  try { await router.refresh(); time += 60000; await router.refresh(); assert.equal(calls, 0); }
  finally { await router.close(); }
}));
