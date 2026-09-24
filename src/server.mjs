import http from 'node:http';
import { once } from 'node:events';
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';

const headersToForward = ['content-type','content-encoding','accept','user-agent','openai-beta','originator','session_id','conversation_id','session-id','thread-id','x-codex-routing-hint','x-codex-turn-state','x-codex-turn-metadata','x-openai-internal-codex-responses-lite','x-codex-image-turn-id'];
const routes = new Map(['/responses','/alpha/search','/images/generations','/images/edits'].map(p => ['/v1'+p, 'https://chatgpt.com/backend-api/codex'+p]));
const equal = (a,b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function startServer({port=8787, credentials, transport=fetch, controlToken, instanceId = 'fixture', onStop=()=>{}, onSelect=null, routingStatus=()=>undefined, maxBytes=16*1024*1024, timeoutMs=240000}) {
  const active = new Set();
  let selecting = false;
  const server = http.createServer(async (req,res) => {
    const fail = (status, code) => { if (res.destroyed || res.writableEnded) return; if(!res.headersSent) res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify({error:{type:'codex_gateway_error',message:code}})); };
    if(req.headers.origin || req.headers.host !== `127.0.0.1:${server.address()?.port}`) return fail(403,'local_client_required');
    if(req.url === '/health' && req.method === 'GET') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({service:'codex-gateway',version:'0.1.0'})); }
    if ((req.url === '/control/stop' && req.method === 'POST') || (req.url === '/control/status' && req.method === 'GET')) {
      if(!controlToken || !equal(req.headers.authorization,`Bearer ${controlToken}`)) return fail(403,'invalid_control_token');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ instanceId, routing: routingStatus() }));
      if (req.url === '/control/stop') setImmediate(onStop);
      return;
    }
    const selection = /^\/control\/account\/(default|[a-f0-9]{24})$/.exec(req.url);
    if (selection && req.method === 'POST') {
      if (!controlToken || !equal(req.headers.authorization, `Bearer ${controlToken}`)) return fail(403, 'invalid_control_token');
      const reply = (status, code) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify({ instanceId, code })); };
      if (active.size || selecting) return reply(409, 'gateway_busy');
      if (!onSelect) return reply(501, 'account_switch_unavailable');
      selecting = true;
      try { await onSelect(selection[1]); reply(200, 'account_selected'); }
      catch (e) { reply(400, e.code === 'login_required' ? 'login_required' : 'account_switch_failed'); }
      finally { selecting = false; }
      return;
    }
    if (selecting) return fail(503, 'account_switch_in_progress');
    const url = routes.get(req.url);
    if(req.method !== 'POST' || !url) return fail(404,'unsupported_route');
    const controller = new AbortController();
    const abort = () => { controller.abort(); req.destroy(); res.destroy(); };
    active.add(abort);
    const timer = setTimeout(() => {
      controller.abort();
      if (!res.headersSent) {
        res.once('finish', () => req.destroy());
        fail(504, 'upstream_timeout');
      } else { req.destroy(); res.destroy(); }
    }, timeoutMs);
    req.on('aborted',()=>controller.abort());
    res.on('close',()=>{if(!res.writableFinished) controller.abort();});
    try {
      let size=0; const chunks=[];
      for await(const chunk of req) { size+=chunk.length; if(size>maxBytes) return fail(413,'request_too_large'); chunks.push(chunk); }
      const body=Buffer.concat(chunks); let parsed;
      try {
        const encoding=req.headers['content-encoding'];
        if(encoding && !['identity','gzip','zstd'].includes(encoding)) return fail(415,'unsupported_encoding');
        const decoded=encoding==='zstd'?zstdDecompressSync(body,{maxOutputLength:maxBytes}):encoding==='gzip'?gunzipSync(body,{maxOutputLength:maxBytes}):body;
        parsed=JSON.parse(decoded.toString());
      } catch { return fail(400,'invalid_request_body'); }
      if(!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.model !== 'string' || !parsed.model.length || parsed.model.length>200) return fail(400,'model_required');
      const stack=[[parsed,0]];
      while(stack.length) { const [v,d]=stack.pop(); if(d>64) return fail(400,'request_too_deep'); if(v && typeof v==='object') for(const x of Object.values(v)) stack.push([x,d+1]); }
      if(req.url==='/v1/responses' && parsed.stream!==true) return fail(400,'streaming_responses_required');
      let auth;
      try { auth = await credentials(); }
      catch (e) {
        if (['weekly_reserve_reached', 'usage_unavailable'].includes(e.code)) return fail(503, e.code);
        return fail(401, 'isolated_login_required');
      }
      controller.signal.throwIfAborted();
      const headers=new Headers();
      for(const name of headersToForward) if(typeof req.headers[name]==='string') headers.set(name,req.headers[name]);
      headers.set('authorization',`Bearer ${auth.token}`);
      headers.set('chatgpt-account-id',auth.account);
      headers.set('accept-encoding','identity');
      const upstream=await transport(url,{method:'POST',headers,body,signal:controller.signal,redirect:'error'});
      if(!upstream.ok) {
        await upstream.body?.cancel();
        if(upstream.status===429 && /^\d{1,6}$/.test(upstream.headers.get('retry-after')??'')) res.setHeader('retry-after',upstream.headers.get('retry-after'));
        return fail(upstream.status,upstream.status===401?'upstream_login_expired':upstream.status===429?'upstream_rate_limited':'upstream_rejected_request');
      }
      const responseHeaders={'content-type':upstream.headers.get('content-type')??'text/event-stream','cache-control':'no-store'};
      for(const name of ['x-codex-turn-state','x-codex-routing-hint']) if(upstream.headers.has(name)) responseHeaders[name]=upstream.headers.get(name);
      res.writeHead(upstream.status,responseHeaders);
      if(upstream.body) for await(const chunk of upstream.body) {
        if(!res.write(chunk)) await once(res,'drain',{signal:controller.signal});
      }
      res.end();
    } catch { if(!res.headersSent) fail(controller.signal.aborted?504:502,controller.signal.aborted?'upstream_timeout':'upstream_unavailable'); else res.destroy(); }
    finally { clearTimeout(timer); active.delete(abort); }
  });
  server.on('upgrade', (req, socket) => {
    // Codex treats 426 as an immediate HTTP fallback; a 404 triggers retries.
    const local = !req.headers.origin && req.headers.host === `127.0.0.1:${server.address()?.port}`;
    const responses = req.method === 'GET' && req.url === '/v1/responses' && req.headers.upgrade?.toLowerCase() === 'websocket';
    const status = !local ? '403 Forbidden' : responses ? '426 Upgrade Required' : '404 Not Found';
    socket.on('error', () => socket.destroy());
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`);
    socket.destroySoon();
  });
  server.requestTimeout=timeoutMs; server.headersTimeout=10000;
  server.listen(port,'127.0.0.1'); await once(server,'listening');
  return { port:server.address().port, close:()=>new Promise(resolve=>{for (const abort of active) abort(); server.close(resolve);server.closeAllConnections();}) };
}
