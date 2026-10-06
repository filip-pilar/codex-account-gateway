import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, access, mkdir, writeFile, readFile, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { ensureState, writePrivate, readPrivate } from '../src/state.mjs';
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function fixture(fn) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'codex-gateway-cli-')));
  const root = join(base, 'gateway'), bin = join(base, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'codex'), `#!${process.execPath}
import readline from 'node:readline';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
if (process.argv.includes('--version')) console.log('codex-cli 0.149.1');
else if (process.argv.includes('app-server')) {
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') console.log(JSON.stringify({id:1,result:{}}));
    if (message.method === 'account/rateLimits/read') {
      let usedPercent = 20, failure = false;
      try { const fixture = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'fixture-usage.json'), 'utf8')); usedPercent = fixture.used; failure = fixture.failure; } catch {}
      if (failure) { console.log(JSON.stringify({id:2,error:{message:'private fixture failure'}})); return; }
      console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent,windowDurationMins:10080}}}}));
    }
  });
} else process.exit(4);
`, {mode:0o700});
  const env = {...process.env, CODEX_GATEWAY_HOME:root, PATH:bin};
  const run = (args, extra = {}) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extra } });
    let out = '', stderr = '', timedOut = false;
    p.stdout.on('data', b => out += b);
    p.stderr.on('data', b => stderr += b);
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, 15000);
    p.once('error', err => { clearTimeout(timer); reject(err); });
    p.once('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('CLI fixture timeout'));
      try {
        resolve({ code, out, stderr, value: args.includes('--json') ? JSON.parse(out) : null });
      } catch (err) { reject(err); }
    });
  });
  const auth = async () => { const home=await ensureState(root); await writePrivate(join(home,'auth.json'), JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:'fixture',account_id:'fixture'}})); };
  const freePort = async () => {const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const port=s.address().port;await new Promise(r=>s.close(r));return port;};
  try {await fn({base,root,run,auth,freePort});}
  finally {await run(['stop','--json']).catch(()=>{}); await rm(base,{recursive:true,force:true});}
}
test('background readiness, concurrent starts, crash recovery and port conflict', {timeout:25000}, () => fixture(async ({run,auth,freePort,root}) => {
  await auth();const port=await freePort();
  const results=await Promise.all([run(['start','--background','--port',String(port),'--json']),run(['start','--background','--port',String(port),'--json'])]);
  assert.deepEqual(results.map(r=>r.value.code).sort(),['already_running','started']);
  assert.equal(results[0].value.pid,results[1].value.pid);
  const different=await run(['start','--port',String(await freePort()),'--json']);assert.equal(different.value.code,'already_running_other_port');
  const old=await readPrivate(join(root,'runtime.json'));process.kill(old.pid,'SIGKILL');
  for(let i=0;i<100;i++){try{process.kill(old.pid,0);}catch{break;}await new Promise(r=>setTimeout(r,20));}
  assert.equal((await run(['status','--json'])).value.state,'stale');
  const restarted=await run(['start','--background','--port',String(port),'--json']);assert.equal(restarted.value.code,'started');assert.notEqual(restarted.value.pid,old.pid);
  assert.equal((await run(['stop','--json'])).value.code,'stopped');
  const occupied=net.createServer();occupied.listen(port,'127.0.0.1');await once(occupied,'listening');
  try {const failed=await run(['start','--background','--port',String(port),'--json']);assert.equal(failed.value.code,'port_in_use');await assert.rejects(access(join(root,'runtime.json')));}
  finally {await new Promise(r=>occupied.close(r));}
}));
test('unverified live PID is never reclaimed or signalled', () => fixture(async ({run,auth,freePort,root}) => {
  await auth();await writePrivate(join(root,'runtime.json'),JSON.stringify({pid:process.pid,port:await freePort(),instanceId:'a'.repeat(32),controlToken:'b'.repeat(64)}));
  assert.equal((await run(['status','--json'])).value.code,'unavailable');
  assert.equal((await run(['start','--json'])).value.code,'runtime_unavailable');
  assert.equal((await run(['stop','--json'])).value.code,'runtime_unavailable');
  assert.equal((await readPrivate(join(root,'runtime.json'))).pid,process.pid);
  await rm(join(root,'runtime.json'));
}));
test('setup requires a model and creates only a new isolated private client', () => fixture(async ({run,root,base}) => {
  assert.equal((await run(['setup','--json'])).code,2);
  const printed=await run(['setup','--model','fixture-model','--json']);assert.match(printed.value.config,/model = "fixture-model"/);await assert.rejects(access(root));
  assert.doesNotMatch(printed.value.config, /experimental_realtime/);
  const voice = await run(['setup', '--model', 'fixture-model', '--port', '18887', '--realtime', '--json']);
  assert.equal(voice.value.code, 'configuration');
  assert.match(voice.value.config, /^experimental_realtime_webrtc_call_base_url = "http:\/\/127\.0\.0\.1:18887\/backend-api\/codex"$/m);
  assert.match(voice.value.config, /^experimental_realtime_ws_base_url = "ws:\/\/127\.0\.0\.1:18887\/v1"$/m);
  assert.ok(voice.value.config.indexOf('experimental_realtime_ws_base_url') < voice.value.config.indexOf('[model_providers.'));
  await assert.rejects(access(root));
  const voiceDir = join(base, 'voice-client');
  const createdVoice = await run(['setup', '--model', 'fixture-model', '--port', '18887', '--realtime', '--client-dir', voiceDir, '--json']);
  assert.equal(createdVoice.value.code, 'configuration_created');
  assert.equal(await readFile(join(voiceDir, 'config.toml'), 'utf8'), voice.value.config);
  assert.equal((await stat(join(voiceDir, 'config.toml'))).mode & 0o777, 0o600);
  assert.equal((await run(['setup', '--model', 'fixture', '--realtime', '--realtime', '--json'])).value.code, 'invalid_arguments');
  const dir=join(base,"client's profile");const made=await run(['setup','--model','fixture-model','--client-dir',dir,'--json']);assert.equal(made.value.code,'configuration_created');
  assert.equal((await stat(dir)).mode & 0o777,0o700);assert.equal((await stat(join(dir,'config.toml'))).mode & 0o777,0o600);
  const original=await readFile(join(dir,'config.toml'),'utf8');assert.doesNotMatch(original,/model_reasoning_effort|check_for_update_on_startup|request_max_retries|stream_max_retries|stream_idle_timeout_ms/);
  assert.equal(made.value.launch.env.CODEX_HOME,dir);assert.deepEqual(made.value.launch.unset_env,['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL']);
  assert.equal((await run(['setup','--model','other','--client-dir',dir,'--json'])).value.code,'client_directory_exists');assert.equal(await readFile(join(dir,'config.toml'),'utf8'),original);
  assert.equal((await run(['setup','--model','fixture','--client-dir',join(root,'codex'),'--json'])).value.code,'unsafe_client_directory');
  const linked=join(base,'link');await symlink(dir,linked);
  assert.equal((await run(['setup','--model','fixture','--client-dir',join(linked,'nested'),'--json'])).code,1);
}));

test('account CLI switches request credentials without changing the gateway address or process', t => fixture(async ({ run, auth, root, base, freePort }) => {
  await auth();
  const added = await run(['account-add', '--label', 'Second', '--json']);
  assert.equal(added.value.code, 'account_added');
  const id = added.value.account.id;
  assert.equal((await run(['account-select', '--account', id, '--json'])).value.code, 'login_required');
  const home = await ensureState(join(root, 'accounts', id));
  await writePrivate(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'second-token', account_id: 'second-account' } }));

  // Replace only the child gateway's upstream transport. All CLI, account-state,
  // control, and forwarding code stays real; no request can reach a service.
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ authorization: req.headers.authorization, account: req.headers['chatgpt-account-id'] }));
    });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const transport = join(base, 'fixture-transport.mjs');
  await writeFile(transport, `
import https from 'node:https';
import http from 'node:http';
https.request = (url, options, listener) => {
  if (url !== 'https://chatgpt.com/backend-api/codex/responses') throw new Error('Unexpected fixture route');
  return http.request('http://127.0.0.1:${upstream.address().port}/fixture', options, listener);
};
globalThis.fetch = () => { throw new Error('Unexpected external fetch in CLI fixture'); };
`);
  const started = await run(['start', '--background', '--port', String(await freePort()), '--json'], {
    NODE_OPTIONS: `--import=${pathToFileURL(transport).href}`,
  });
  assert.equal(started.value.code, 'started');
  const requestCredentials = async () => {
    const response = await fetch(`${started.value.url}/responses`, {
      method: 'POST',
      body: JSON.stringify({ model: 'fixture', stream: true, input: [] }),
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual(await requestCredentials(), { authorization: 'Bearer fixture', account: 'fixture' });
  assert.equal((await run(['account-select', '--account', id, '--json'])).value.code, 'account_selected');
  assert.deepEqual(await requestCredentials(), { authorization: 'Bearer second-token', account: 'second-account' });

  const status = await run(['status', '--json']);
  assert.equal(status.value.pid, started.value.pid);
  assert.equal(status.value.url, started.value.url);
  const accounts = (await run(['accounts', '--json'])).value.accounts;
  assert.equal(accounts.find(a => a.selected).id, id);
  assert.equal((await run(['account-select', '--account', 'default', '--json'])).value.code, 'account_selected');
  assert.deepEqual(await requestCredentials(), { authorization: 'Bearer fixture', account: 'fixture' });
  assert.equal((await run(['account-select', '--account', '../../oops', '--json'])).value.code, 'invalid_account');
}));

test('shared usage CLI reports cached routing readings, refreshes them, and retains safe failure details', () => fixture(async ({ run, root, auth, freePort }) => {
  await auth();
  assert.equal((await run(['usage-status', '--json'])).value.code, 'runtime_unavailable');
  assert.equal((await run(['start', '--background', '--port', String(await freePort()), '--json'])).value.code, 'started');
  async function settled() {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const result = await run(['usage-status', '--json']);
      assert.equal(result.value.code, 'usage_status');
      assert.doesNotMatch(result.out, /controlToken|instanceId|private fixture|access_token/);
      if (!result.value.usage_status.checking) return result.value;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('usage refresh did not finish');
  }
  const initial = await settled();
  assert.equal(initial.usage_status.accounts[0].buckets[0].primary.remaining_percent, 80);
  const path = join(root, 'codex', 'fixture-usage.json');
  await writeFile(path, JSON.stringify({ used: 95 }));
  const cached = await run(['usage-status', '--json']);
  assert.equal(cached.value.usage_status.accounts[0].buckets[0].primary.remaining_percent, 80);
  assert.equal((await run(['usage-status', '--refresh', '--json'])).value.code, 'usage_status');
  const reserve = await settled();
  assert.equal(reserve.routing.state, 'weekly_reserve_reached');
  assert.equal(reserve.usage_status.accounts[0].buckets[0].primary.remaining_percent, 5);
  await writeFile(path, JSON.stringify({ failure: true }));
  await run(['usage-status', '--refresh', '--json']);
  const failed = await settled();
  assert.equal(failed.routing.state, 'weekly_reserve_reached');
  assert.equal(failed.usage_status.accounts[0].diagnostics.last_error, 'rpc_error');
  assert.equal(failed.usage_status.accounts[0].diagnostics.consecutive_failures, 1);
  assert.equal(failed.usage_status.accounts[0].stale, true);
  assert.equal(failed.usage_status.accounts[0].buckets[0].primary.remaining_percent, 5);
  await writeFile(path, JSON.stringify({ used: 10 }));
  await run(['usage-status', '--refresh', '--json']);
  const recovered = await settled();
  assert.equal(recovered.routing.state, 'ready');
  assert.equal(recovered.usage_status.accounts[0].diagnostics.last_error, null);
}));

test('CLI reports configured and effective limits and rejects invalid profiles', { timeout: 20000 }, () => fixture(async ({ run, root, auth, freePort }) => {
  await auth();
  const path = join(root, 'limits.json');
  const limits = { max_request_bytes: 1024, idle_timeout_ms: 5000, max_header_bytes: 65536 };
  await writeFile(path, JSON.stringify(limits), { mode: 0o600 });
  assert.deepEqual((await run(['doctor', '--json'])).value.limits, limits);
  assert.equal((await run(['start', '--background', '--port', String(await freePort()), '--json'])).value.code, 'started');
  const status = (await run(['status', '--json'])).value;
  assert.deepEqual(status.limits, limits); assert.equal(status.active_requests, 0);
  await writeFile(path, '{"idle_timeout_ms":0}');
  assert.deepEqual((await run(['status', '--json'])).value.limits, limits, 'running settings remain unchanged until restart');
  const doctor = (await run(['doctor', '--json'])).value;
  assert.equal(doctor.code, 'local_not_ready'); assert.equal(doctor.limits_error, 'invalid_limits');
  assert.equal((await run(['stop', '--json'])).value.code, 'stopped');
  assert.equal((await run(['start', '--json'])).value.code, 'invalid_limits');
}));

test('reserve CLI defaults off, persists while stopped, applies live, and survives restart', () => fixture(async ({ run, auth, freePort, root }) => {
  const setting = async (...args) => (await run(['reserve-usage', ...args, '--json'])).value;
  assert.equal((await setting()).allow_reserve_usage, false);
  assert.equal((await setting('--enabled', 'yes')).code, 'invalid_arguments');
  assert.equal((await setting('--enabled', 'true')).allow_reserve_usage, true);
  assert.equal((await stat(join(root, 'reserve-usage.json'))).mode & 0o777, 0o600);
  await auth();
  await writeFile(join(root, 'codex', 'fixture-usage.json'), JSON.stringify({ used: 99 }));
  const port = String(await freePort());
  assert.equal((await run(['start', '--background', '--port', port, '--json'])).value.code, 'started');
  assert.equal((await setting('--enabled', 'false')).allow_reserve_usage, false);
  assert.equal((await setting('--enabled', 'true')).allow_reserve_usage, true);
  const status = (await run(['status', '--json'])).value;
  assert.equal(status.routing.allow_reserve_usage, true);
  assert.ok(['ready', 'usage_degraded'].includes(status.routing.state));
  assert.equal((await run(['stop', '--json'])).value.code, 'stopped');
  assert.equal((await run(['start', '--background', '--port', port, '--json'])).value.code, 'started');
  assert.equal((await run(['status', '--json'])).value.routing.allow_reserve_usage, true);
}));

test('credit CLI defaults off, validates input, applies live, and persists across restart', () => fixture(async ({ run, auth, freePort, root }) => {
  const setting = async (...args) => (await run(['credit-fallback', '--account', 'default', ...args, '--json'])).value;
  assert.equal((await setting()).allow_credit_fallback, false);
  assert.equal((await setting('--enabled', 'yes')).code, 'invalid_arguments');
  assert.equal((await run(['credit-fallback', '--json'])).value.code, 'invalid_arguments');
  assert.equal((await setting('--enabled', 'true')).allow_credit_fallback, true);
  assert.equal((await stat(join(root, 'credit-fallback.json'))).mode & 0o777, 0o600);
  await auth();
  await run(['start', '--background', '--port', String(await freePort()), '--json']);
  assert.equal((await setting('--enabled', 'false')).allow_credit_fallback, false);
  assert.equal((await setting('--enabled', 'true')).allow_credit_fallback, true);
  await run(['stop', '--json']);
  await run(['start', '--background', '--port', String(await freePort()), '--json']);
  assert.equal((await run(['accounts', '--json'])).value.accounts[0].allow_credit_fallback, true);
}));
