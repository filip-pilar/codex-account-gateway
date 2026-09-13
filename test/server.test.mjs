import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startServer } from '../src/server.mjs';
const auth=async()=>({token:'backing-fixture',account:'fixture-account'});
const body={model:'fixture-model',stream:true,input:[],reasoning:{effort:'low'}};
test('client cancellation aborts upstream work',async()=>{
  let aborted;const done=new Promise(r=>aborted=r);
  const s=await startServer({port:0,credentials:auth,transport:async(u,o)=>{
    o.signal.addEventListener('abort',aborted,{once:true});
    return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {}\n\n'));o.signal.addEventListener('abort',()=>c.close(),{once:true});}}));
  }});
  try{const controller=new AbortController();const r=await fetch(`http://127.0.0.1:${s.port}/v1/responses`,{method:'POST',body:JSON.stringify(body),signal:controller.signal});await r.body.getReader().read();controller.abort();await Promise.race([done,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('abort not propagated')),1500);t.unref();})]);}finally{await s.close();}
});
test('preserves exact compressed bytes, routing/state; replaces credentials',async()=>{
  const bytes=gzipSync(JSON.stringify(body));let seen;
  const s=await startServer({port:0,credentials:auth,transport:async(url,opts)=>{
    seen=opts;assert.match(url,/codex\/responses$/);assert.deepEqual(opts.body,bytes);
    return new Response('data: {"type":"response.completed"}\n\n',{headers:{'content-type':'text/event-stream','x-codex-turn-state':'returned-state'}});
  }});
  try {
    const r=await fetch(`http://127.0.0.1:${s.port}/v1/responses`,{method:'POST',headers:{'content-encoding':'gzip',authorization:'Bearer caller','x-api-key':'caller-key','x-openai-actor-authorization':'marker','session-id':'session','thread-id':'thread','x-codex-turn-state':'state'},body:bytes});
    assert.equal(r.status,200);assert.equal(r.headers.get('x-codex-turn-state'),'returned-state');await r.text();
    assert.equal(seen.headers.get('authorization'),'Bearer backing-fixture');assert.equal(seen.headers.get('chatgpt-account-id'),'fixture-account');
    for(const h of ['x-api-key','x-openai-actor-authorization'])assert.equal(seen.headers.has(h),false);
    assert.equal(seen.headers.get('session-id'),'session');assert.equal(seen.headers.get('thread-id'),'thread');assert.equal(seen.headers.get('x-codex-turn-state'),'state');
  }finally{await s.close();}
});
test('routes native image generation/edit and standalone search unchanged',async()=>{
  const urls=[];const s=await startServer({port:0,credentials:auth,transport:async(u,o)=>{urls.push(u);return new Response('{"data":[]}',{headers:{'content-type':'application/json'}});}});
  try{for(const path of ['images/generations','images/edits','alpha/search']){const r=await fetch(`http://127.0.0.1:${s.port}/v1/${path}`,{method:'POST',body:JSON.stringify({model:'fixture'})});assert.equal(r.status,200);await r.text();assert.equal(urls.at(-1),`https://chatgpt.com/backend-api/codex/${path}`);}}finally{await s.close();}
});
test('rejects browser origins, oversized/deep/invalid bodies; redacts upstream errors without retry',async()=>{
  let calls=0;const s=await startServer({port:0,credentials:auth,maxBytes:1024,transport:async()=>{calls++;return new Response('secret upstream detail',{status:429,headers:{'retry-after':'2'}});}});
  const send=(b,headers={})=>fetch(`http://127.0.0.1:${s.port}/v1/responses`,{method:'POST',headers,body:b});
  try {
    assert.equal((await send(JSON.stringify(body),{origin:'https://example.com'})).status,403);
    assert.equal((await send('x'.repeat(1025))).status,413);
    assert.equal((await send('{')).status,400);
    let deep={};for(let i=0;i<66;i++)deep={a:deep};assert.equal((await send(JSON.stringify({...body,input:deep}))).status,400);
    const r=await send(JSON.stringify(body));assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'2');assert.doesNotMatch(await r.text(),/secret/);assert.equal(calls,1);
  }finally{await s.close();}
});
test('control endpoint requires its private token',async()=>{
  let stopped=false;const s=await startServer({port:0,credentials:auth,controlToken:'test-token',onStop:()=>{stopped=true;}});
  try{const url=`http://127.0.0.1:${s.port}/control/stop`;assert.equal((await fetch(url,{method:'POST'})).status,403);assert.equal(stopped,false);const r=await fetch(url,{method:'POST',headers:{authorization:'Bearer test-token'}});await r.text();assert.equal(r.status,200);await new Promise(setImmediate);assert.equal(stopped,true);}finally{await s.close();}
});

test('deadline closes a stalled upload without forwarding', async()=>{
  const {default:http}=await import('node:http');let calls=0;
  const s=await startServer({port:0,credentials:auth,timeoutMs:80,transport:async()=>{calls++;return new Response('');}});
  try {
    const status=await new Promise((resolve,reject)=>{
      const req=http.request(`http://127.0.0.1:${s.port}/v1/responses`,{method:'POST',headers:{'content-length':'1000'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
      req.on('error',reject);req.write('{');
    });
    assert.equal(status,504);assert.equal(calls,0);
  }finally{await s.close();}
});
test('shutdown aborts upstream before response headers and closes waiting clients',async()=>{
  let started;const ready=new Promise(r=>started=r);let aborted=false;
  const s=await startServer({port:0,credentials:auth,transport:async(u,o)=>{started();return new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true}));}});
  const request=fetch(`http://127.0.0.1:${s.port}/v1/responses`,{method:'POST',body:JSON.stringify(body)}).catch(()=>null);
  await ready;await s.close();await request;assert.equal(aborted,true);
});
test('zstd bytes and image/search bodies remain exact; login errors are redacted',async()=>{
  const {zstdCompressSync}=await import('node:zlib');
  const bytes=zstdCompressSync(Buffer.from(JSON.stringify(body)));let seen;
  const s=await startServer({port:0,credentials:auth,transport:async(u,o)=>{seen=o.body;return new Response('private detail',{status:401});}});
  try {
    for(const route of ['responses','images/generations','images/edits','alpha/search']) {
      const r=await fetch(`http://127.0.0.1:${s.port}/v1/${route}`,{method:'POST',headers:{'content-encoding':'zstd'},body:bytes});
      assert.deepEqual(seen,bytes);assert.equal(r.status,401);assert.equal((await r.json()).error.message,'upstream_login_expired');
    }
  }finally{await s.close();}
});
