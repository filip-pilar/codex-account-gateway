import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.mjs';
import { writePrivate } from '../src/state.mjs';
const run=promisify(execFile),script=fileURLToPath(new URL('../scripts/smoke-live.mjs',import.meta.url));
test('smoke requires opt-in and performs exactly one bounded request against a local fixture',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'gateway-smoke-')));let calls=0, mode='ok';
  const s=await startServer({port:0,controlToken:'b'.repeat(64),instanceId:'a'.repeat(32),credentials:async()=>({token:'fixture',account:'fixture'}),transport:async(u,o)=>{
    calls++;const body=JSON.parse(o.body);assert.equal(body.reasoning.effort,'low');assert.equal(body.tools,undefined);assert.equal(body.stream,true);
    if(mode==='reject')return new Response('PRIVATE',{status:401});
    return new Response('data: {"type":"response.output_text.delta","delta":"PRIVATE"}\n\n'+(mode==='ok'?'data: {"type":"response.completed"}\n\n':''));
  }});
  const invoke=async(args)=>{try{return await run(process.execPath,[script,...args],{env:{...process.env,CODEX_GATEWAY_HOME:root},timeout:10000});}catch(e){return e;}};
  try {
    await writePrivate(join(root,'runtime.json'),JSON.stringify({pid:process.pid,port:s.port,instanceId:'a'.repeat(32),controlToken:'b'.repeat(64)}));
    const refused=await invoke([]);assert.equal(refused.code,2);assert.equal(calls,0);
    for(const selected of ['ok','incomplete','reject']) {
      mode=selected;const before=calls;const result=await invoke(['--allow-inference','--model','fixture']);const value=JSON.parse(result.stdout);
      assert.equal(calls,before+1);assert.equal(value.ok,selected==='ok');assert.doesNotMatch(result.stdout,/PRIVATE/);
      if(selected==='reject')assert.equal(value.next_action,'login');
    }
  }finally{await s.close();await rm(root,{recursive:true,force:true});}
});
