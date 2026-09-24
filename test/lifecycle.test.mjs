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
import { startServer } from '../src/server.mjs';
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
} else {
  if(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_BASE_URL) process.exit(4);
  console.log('fixture login');
}
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
  try {await fn({base,root,env,run,auth,freePort});}
  finally {await run(['stop','--json']).catch(()=>{}); await rm(base,{recursive:true,force:true});}
}
test('foreground start/status/stop verifies identity and cleans runtime', {timeout:20000}, () => fixture(async ({env,run,auth,freePort,root}) => {
  await auth(); const port=await freePort();
  const p=spawn(process.execPath,[cli,'start','--port',String(port),'--json'],{env});p.stderr.resume();
  try {
    const first = await new Promise(resolve=>p.stdout.once('data', b=>resolve(JSON.parse(b))));
    assert.equal(first.code,'started'); const exited=once(p,'exit');
    const status=await run(['status','--json']);assert.equal(status.value.code,'running');assert.equal(status.value.pid,p.pid);
    assert.doesNotMatch(status.out,/controlToken|instanceId|backing-fixture/);
    assert.equal((await run(['stop','--json'])).value.code,'stopped');await exited;
    await assert.rejects(access(join(root,'runtime.json')));
    assert.equal((await run(['stop','--json'])).value.code,'already_stopped');
  } finally {p.kill();}
}));
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
test('doctor is read-only, aggregates failures, and exposes safe CLI version', () => fixture(async ({run,root,auth}) => {
  const absent=await run(['doctor','--json'],{PATH:'/nonexistent'});
  assert.equal(absent.code,1);assert.equal(absent.value.cli.version,null);assert.equal(absent.value.credentials,'missing_or_unsafe');assert.equal(absent.value.runtime.state,'stopped');
  await assert.rejects(access(root));
  await auth();const ready=await run(['doctor','--json']);assert.equal(ready.value.cli.version,'0.149.1');assert.equal(ready.value.upstream,'not_checked');
}));
test('setup requires a model and creates only a new isolated private client', () => fixture(async ({run,root,base}) => {
  assert.equal((await run(['setup','--json'])).code,2);
  const printed=await run(['setup','--model','fixture-model','--json']);assert.match(printed.value.config,/model = "fixture-model"/);await assert.rejects(access(root));
  const dir=join(base,"client's profile");const made=await run(['setup','--model','fixture-model','--client-dir',dir,'--json']);assert.equal(made.value.code,'configuration_created');
  assert.equal((await stat(dir)).mode & 0o777,0o700);assert.equal((await stat(join(dir,'config.toml'))).mode & 0o777,0o600);
  const original=await readFile(join(dir,'config.toml'),'utf8');assert.match(original,/model_reasoning_effort = "low"/);assert.match(original,/check_for_update_on_startup = false/);
  assert.equal(made.value.launch.env.CODEX_HOME,dir);assert.deepEqual(made.value.launch.unset_env,['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL']);
  assert.equal((await run(['setup','--model','other','--client-dir',dir,'--json'])).value.code,'client_directory_exists');assert.equal(await readFile(join(dir,'config.toml'),'utf8'),original);
  assert.equal((await run(['setup','--model','fixture','--client-dir',join(root,'codex'),'--json'])).value.code,'unsafe_client_directory');
  const linked=join(base,'link');await symlink(dir,linked);
  assert.equal((await run(['setup','--model','fixture','--client-dir',join(linked,'nested'),'--json'])).code,1);
}));
test('machine argument errors are stable and login strips inherited provider overrides', () => fixture(async ({run}) => {
  for(const args of [['nope'],['start','--port','1'],['status','--port','8787']]) {
    const r=await run([...args,'--json']);assert.equal(r.code,2);assert.equal(r.value.schema_version,1);assert.equal(r.value.code,'invalid_arguments');
  }
  assert.equal((await run(['login','--json'])).value.code,'invalid_arguments');
  assert.equal((await run(['login'],{OPENAI_API_KEY:'fixture',CODEX_API_KEY:'fixture',OPENAI_BASE_URL:'http://fixture.invalid'})).code,0);
}));

test('another gateway on the recorded port is not accepted or stopped', () => fixture(async ({run,auth,root}) => {
  await auth();let stopped=false;
  const server=await startServer({port:0,credentials:async()=>({token:'fixture',account:'fixture'}),controlToken:'c'.repeat(64),instanceId:'d'.repeat(32),onStop:()=>{stopped=true;}});
  try {
    await writePrivate(join(root,'runtime.json'),JSON.stringify({pid:process.pid,port:server.port,instanceId:'a'.repeat(32),controlToken:'b'.repeat(64)}));
    assert.equal((await run(['status','--json'])).value.code,'unavailable');
    assert.equal((await run(['stop','--json'])).value.code,'runtime_unavailable');
    assert.equal(stopped,false);
  } finally {await server.close();await rm(join(root,'runtime.json'));}
}));

test('concurrent stops all return successful JSON after instance cleanup', {timeout:20000}, () => fixture(async ({run,auth,freePort}) => {
  await auth();
  assert.equal((await run(['start','--background','--port',String(await freePort()),'--json'])).value.code,'started');
  const results=await Promise.all(Array.from({length:6},()=>run(['stop','--json'])));
  for(const result of results) {assert.equal(result.code,0);assert.equal(result.value.ok,true);assert.equal(result.stderr,'');}
  assert.equal((await run(['status','--json'])).value.state,'stopped');
}));

test('doctor reports leftover lifecycle lock without modifying it', () => fixture(async ({run,auth,root,freePort}) => {
  await auth();const lock=join(root,'lifecycle.lock');await mkdir(lock,{mode:0o700});
  const result=await run(['doctor','--port',String(await freePort()),'--json']);
  assert.equal(result.code,1);assert.equal(result.value.code,'local_not_ready');
  assert.equal(result.value.lifecycle_lock,'present');assert.equal(result.value.next_action,'inspect_private_state');
  assert.equal((await stat(lock)).isDirectory(),true);
}));

test('FIFO and null runtime state return safe errors instead of hanging', {timeout:10000}, () => fixture(async ({run,auth,root}) => {
  await auth();const path=join(root,'runtime.json');
  const fifo=spawn('/usr/bin/mkfifo',[path]);assert.equal((await once(fifo,'exit'))[0],0);
  assert.equal((await run(['status','--json'])).value.code,'unsafe_runtime');
  assert.equal((await run(['doctor','--json'])).value.runtime.state,'unsafe');
  await rm(path);await writePrivate(path,'null');
  assert.equal((await run(['status','--json'])).value.code,'unsafe_runtime');
  await rm(path);
  await rm(join(root,'codex','auth.json'));
  const authFifo=spawn('/usr/bin/mkfifo',[join(root,'codex','auth.json')]);assert.equal((await once(authFifo,'exit'))[0],0);
  assert.equal((await run(['doctor','--json'])).value.credentials,'missing_or_unsafe');
}));

test('doctor deadline terminates an unresponsive CLI version child', { timeout: 30000 }, () => fixture(async ({ run, base }) => {
  // The connection closes when the fixture child exits. This checks termination
  // directly instead of treating a fast doctor response as proof of cleanup.
  const observer = net.createServer();
  observer.listen(0, '127.0.0.1');
  await once(observer, 'listening');
  const waiting = new AbortController();
  let socket;
  try {
    await writeFile(join(base, 'bin', 'codex'), `#!${process.execPath}
import net from 'node:net';
process.on('SIGTERM', () => {});
net.connect(${observer.address().port}, '127.0.0.1');
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const signal = AbortSignal.any([waiting.signal, AbortSignal.timeout(15000)]);
    const exited = once(observer, 'connection', { signal }).then(async ([connected]) => {
      socket = connected;
      await once(socket, 'close', { signal });
    });
    const [result] = await Promise.all([run(['doctor', '--json']), exited]);
    assert.equal(result.value.cli.version, null);
    assert.equal(result.code, 1);
  } finally {
    waiting.abort();
    socket?.destroy();
    await new Promise(resolve => observer.close(resolve));
  }
}));

for (const mode of ['oversized', 'redirect', 'stalled']) {
  test(`control probe rejects ${mode} responses`, { timeout: 30000 }, () => fixture(async ({ run, auth, root }) => {
    await auth();
    const paths = [], instanceId = 'a'.repeat(32);
    const server = http.createServer((req, res) => {
      paths.push(req.url);
      if (mode === 'oversized') {
        // Valid identity and JSON: removing the size cap must make this fail.
        res.end(JSON.stringify({ instanceId, padding: 'x'.repeat(2048) }));
      } else if (mode === 'redirect') {
        if (req.url === '/control/status') res.writeHead(302, { location: '/unexpected' });
        res.end(JSON.stringify({ instanceId }));
      } else {
        res.writeHead(200);
        res.flushHeaders();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      await writePrivate(join(root, 'runtime.json'), JSON.stringify({
        pid: process.pid, port: server.address().port, instanceId, controlToken: 'b'.repeat(64),
      }));
      const result = await run(['status', '--json']);
      assert.equal(result.code, 1);
      assert.equal(result.value.code, 'unavailable');
      assert.equal(result.stderr, '');
      assert.deepEqual(paths, ['/control/status']);
    } finally {
      await rm(join(root, 'runtime.json'));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }));
}

test('account CLI switches request credentials without changing the gateway address or process', () => fixture(async ({ run, auth, root, base, freePort }) => {
  await auth();
  const added = await run(['account-add', '--label', 'Second', '--json']);
  assert.equal(added.value.code, 'account_added');
  const id = added.value.account.id;
  assert.equal((await run(['account-select', '--account', id, '--json'])).value.code, 'login_required');
  const home = await ensureState(join(root, 'accounts', id));
  await writePrivate(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'second-token', account_id: 'second-account' } }));

  // Replace only the child gateway's upstream transport. All CLI, account-state,
  // control, and forwarding code stays real; no request can reach a service.
  const transport = join(base, 'fixture-transport.mjs');
  await writeFile(transport, `
globalThis.fetch = async (url, options) => {
  if (url !== 'https://chatgpt.com/backend-api/codex/responses') throw new Error('Unexpected fixture route');
  return Response.json({
    authorization: options.headers.get('authorization'),
    account: options.headers.get('chatgpt-account-id'),
  });
};
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

test('CLI automatically selects a usable account and persists it across restart', () => fixture(async ({ run, root, auth, freePort }) => {
  const id = (await run(['account-add', '--label', 'Second', '--json'])).value.account.id;
  const home = await ensureState(join(root, 'accounts', id));
  await writePrivate(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-second', account_id: 'fixture-second' } }));
  // Local readiness and startup don't require the currently selected Default to
  // be signed in when another account is ready.
  assert.equal((await run(['doctor', '--json'])).value.credentials, 'present');
  const port = await freePort();
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await run(['start', '--background', '--port', String(port), '--json'])).value.code, 'started');
    let status;
    const deadline = Date.now() + 5000;
    do {
      status = (await run(['status', '--json'])).value;
      if (status.routing?.state === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    assert.deepEqual(status.routing, { mode: 'automatic', weekly_reserve_percent: 5, state: 'ready', account: id });
    assert.equal((await run(['accounts', '--json'])).value.accounts.find(item => item.selected).id, id);
    assert.equal((await run(['stop', '--json'])).value.code, 'stopped');
    // Default now has a login but is at the reserve. Restart must keep Second.
    if (attempt === 0) {
      await auth();
      await writeFile(join(root, 'codex', 'fixture-usage.json'), JSON.stringify({ used: 95 }));
    }
  }
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
