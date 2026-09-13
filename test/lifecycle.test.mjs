import { fileURLToPath } from 'node:url';
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
  await writeFile(join(bin, 'codex'), `#!${process.execPath}\nif(process.argv.includes('--version')) { console.log('codex-cli 0.149.1'); } else { if(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.OPENAI_BASE_URL) process.exit(4); console.log('fixture login'); }\n`, {mode:0o700});
  const env = {...process.env, CODEX_GATEWAY_HOME:root, PATH:bin};
  const run = (args, extra = {}) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [cli, ...args], {env:{...env,...extra}});
    let out = '', stderr = '';
    p.stdout.on('data', b => out += b); p.stderr.on('data', b => stderr += b);
    const timer = setTimeout(() => {p.kill('SIGKILL'); reject(new Error('CLI fixture timeout'));}, 15000);
    p.once('error', reject); p.once('close', code => {clearTimeout(timer); resolve({code, out, stderr, value:args.includes('--json') ? JSON.parse(out) : null});});
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

test('doctor deadline terminates an unresponsive CLI version child', {timeout:8000}, () => fixture(async ({run,base}) => {
  await writeFile(join(base,'bin','codex'),`#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,{mode:0o700});
  const began=Date.now();const result=await run(['doctor','--json']);
  assert.equal(result.value.cli.version,null);assert.equal(result.code,1);
  assert.ok(Date.now()-began<5000,'version timeout must also release child process handles');
}));

test('control probes bound response reads and deadlines without following redirects', {timeout:8000}, () => fixture(async ({run,auth,root}) => {
  await auth();let mode='oversized';const paths=[];
  const server=http.createServer((req,res)=>{
    paths.push(req.url);
    if(mode==='oversized')res.end('x'.repeat(2048));
    else if(mode==='redirect'){res.writeHead(302,{location:'/unexpected'});res.end();}
    else {res.writeHead(200);res.flushHeaders();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    await writePrivate(join(root,'runtime.json'),JSON.stringify({pid:process.pid,port:server.address().port,instanceId:'a'.repeat(32),controlToken:'b'.repeat(64)}));
    for(const selected of ['oversized','redirect','stalled']) {
      mode=selected;const result=await run(['status','--json']);
      assert.equal(result.value.code,'unavailable');assert.equal(result.stderr,'');
    }
    assert.deepEqual(paths,Array(3).fill('/control/status'));
  }finally{await rm(join(root,'runtime.json'));server.closeAllConnections();await new Promise(r=>server.close(r));}
}));
