import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import net from 'node:net';
import { ensureState, writePrivate } from '../src/state.mjs';
import { readUsage, normalizeUsage } from '../src/usage.mjs';
async function fixture(fn) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gateway-usage-')));
  const auth = async path => {
    const home = await ensureState(path);
    await writePrivate(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-secret', account_id: 'fixture-id' } }));
  };
  try { await fn(root, auth); } finally { await rm(root, { recursive: true, force: true }); }
}
test('usage preserves separate buckets, clamps percentages, and never invents missing windows', () => {
  const result = normalizeUsage({ rateLimits: { primary: { usedPercent: 12 } }, rateLimitsByLimitId: {
    codex: { primary: { usedPercent: 36, windowDurationMins: 300, resetsAt: 100 }, secondary: null, credits: { balance: 'secret' } },
    other: { primary: { usedPercent: 110 }, secondary: { usedPercent: -20 } },
    unknown: { primary: { usedPercent: null } },
  }});
  assert.deepEqual(result[0], { id: 'codex', primary: { remaining_percent: 64, window_minutes: 300, resets_at: 100 }, secondary: null, credits: null });
  assert.equal(result[1].primary.remaining_percent, 0); assert.equal(result[1].secondary.remaining_percent, 100);
  assert.equal(result[2].primary, null); assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.deepEqual(normalizeUsage({}), []);
  const credits = normalizeUsage({ rateLimits: { credits: { hasCredits: true, unlimited: false, balance: '62706.25' } } });
  assert.deepEqual(credits[0].credits, { has_credits: true, unlimited: false, balance: 62706.25 });
});

test('usage RPC only initializes and reads limits; inherited provider secrets are stripped', () => fixture(async(root, auth) => {
  await auth(root);
  const executable = join(root, 'codex-fixture');
  await writeFile(executable, `#!${process.execPath}
import readline from 'node:readline';
if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_BASE_URL || process.env.CODEX_HOME !== ${JSON.stringify(join(root, 'codex'))}) process.exit(8);
let step = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
 const msg = JSON.parse(line);
 if (step++ === 0 && msg.method === 'initialize') console.log(JSON.stringify({id:1,result:{}}));
 else if (step === 2 && msg.method === 'initialized') {}
 else if (step === 3 && msg.method === 'account/rateLimits/read') console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:100}}}}));
 else process.exit(9);
});`, { mode: 0o700 });
  // Supply overrides in a separate process so the assertion cannot pass just
  // because the developer's environment happens to have no provider secrets.
  const script = `
    import { readUsage } from ${JSON.stringify(new URL('../src/usage.mjs', import.meta.url).href)};
    console.log(JSON.stringify(await readUsage(${JSON.stringify(root)}, { executable: ${JSON.stringify(executable)} })));
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', script], {
    env: {
      ...process.env,
      OPENAI_API_KEY: 'fixture-openai-secret',
      CODEX_API_KEY: 'fixture-codex-secret',
      OPENAI_BASE_URL: 'http://fixture.invalid',
      CODEX_HOME: join(root, 'wrong-client-home'),
    },
    timeout: 20000,
  });
  const result = JSON.parse(stdout);
  assert.equal(stderr, '');
  assert.equal(result.buckets[0].primary.remaining_percent, 75);
  assert.ok(result.checked_at);
}));
test('usage RPC errors are redacted; timeout and cancellation terminate children', () => fixture(async(root, auth) => {
  await auth(root); const executable = join(root, 'codex-fixture');
  await writeFile(executable, `#!${process.execPath}\nconsole.log(JSON.stringify({id:1,error:{message:'private detail'}})); setInterval(()=>{},1000);`, {mode:0o700});
  await assert.rejects(readUsage(root,{executable}), e => e.code === 'usage_unavailable' && e.category === 'rpc_error' && !e.message.includes('private') && !e.message.includes('login'));
  await writeFile(executable, `#!${process.execPath}\nconsole.log('null'); setInterval(()=>{},1000);`, {mode:0o700});
  await assert.rejects(readUsage(root,{executable}), {code:'usage_unavailable',category:'invalid_response'});
  await writeFile(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);`, {mode:0o700});
  const start = Date.now(); await assert.rejects(readUsage(root,{executable,timeoutMs:100}), {code:'usage_timeout',category:'timeout'});
  assert.ok(Date.now()-start < 2000);
  const observer = net.createServer();
  observer.listen(0, '127.0.0.1');
  await once(observer, 'listening');
  const cancellation = new AbortController();
  let socket;
  try {
    await writeFile(executable, `#!${process.execPath}
import net from 'node:net';
process.on('SIGTERM', () => {});
net.connect(${observer.address().port}, '127.0.0.1');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const connected = once(observer, 'connection', { signal: AbortSignal.timeout(5000) });
    const reading = assert.rejects(readUsage(root, { executable, signal: cancellation.signal }), { code: 'usage_unavailable' });
    [socket] = await connected;
    const exited = once(socket, 'close', { signal: AbortSignal.timeout(5000) });
    cancellation.abort();
    await Promise.all([reading, exited]);
  } finally {
    cancellation.abort();
    socket?.destroy();
    await new Promise(resolve => observer.close(resolve));
  }
}));
