#!/usr/bin/env node
// Explicitly gated, one-request check. Never print model output or upstream errors.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== '--allow-inference' || args[1] !== '--model' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(args[2])) {
    console.log(JSON.stringify({ok:false,code:'explicit_inference_authorization_required',usage:'npm run smoke:live -- --allow-inference --model MODEL'}));
    process.exitCode = 2; return;
  }
  const {stdout} = await run(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'status', '--json'], {timeout:5000,maxBuffer:8192});
  const status = JSON.parse(stdout);
  if (!status.ok || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(status.url)) throw new Error('not running');
  const response = await fetch(`${status.url}/responses`, {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(30000),
    headers:{'content-type':'application/json'},
    body:JSON.stringify({model:args[2],stream:true,store:false,instructions:'Reply briefly.',reasoning:{effort:'low'},input:[{role:'user',content:[{type:'input_text',text:'Reply with OK.'}]}]}),
  });
  if (!response.ok) {await response.body?.cancel();console.log(JSON.stringify({ok:false,code:'upstream_rejected',status:response.status,requests:1,next_action:response.status===401?'login':'inspect_compatibility'}));process.exitCode=1;return;}
  let pending='', bytes=0, completed=false, text=false;
  const decoder=new TextDecoder();
  for await (const chunk of response.body) {
    bytes+=chunk.length;if(bytes>1024*1024)throw new Error('response limit');
    pending+=decoder.decode(chunk,{stream:true});
    let end;
    while((end=pending.indexOf('\n'))!==-1) {
      const line=pending.slice(0,end).trimEnd();pending=pending.slice(end+1);
      if(!line.startsWith('data:'))continue;
      const payload=line.slice(5).trim();if(payload==='[DONE]')continue;
      const event=JSON.parse(payload);
      if(event.type==='response.output_text.delta' && typeof event.delta==='string' && event.delta.length)text=true;
      if(event.type==='response.completed')completed=true;
    }
  }
  const ok=completed&&text;
  console.log(JSON.stringify({ok,code:ok?'live_smoke_passed':'incomplete_response',requests:1}));
  if(!ok)process.exitCode=1;
}
main().catch(()=>{console.log(JSON.stringify({ok:false,code:'smoke_failed',request_limit:1,next_action:'doctor'}));process.exitCode=1;});
