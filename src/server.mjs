import http from 'node:http';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { DEFAULT_LIMITS, validateLimits } from './limits.mjs';
import { requestUpstream } from './transport.mjs';

const headersToForward = ['content-type','content-encoding','content-length','accept','user-agent','openai-beta','originator','session_id','conversation_id','session-id','thread-id','x-codex-routing-hint','x-codex-turn-state','x-codex-turn-metadata','x-openai-internal-codex-responses-lite','x-codex-image-turn-id'];
const responseHeadersToForward = ['content-type', 'content-encoding', 'content-length', 'retry-after', 'retry-after-ms', 'x-request-id', 'x-codex-turn-state', 'x-codex-routing-hint'];
const routes = new Map(['/responses','/responses/compact','/alpha/search','/images/generations','/images/edits'].map(p => ['/v1'+p, 'https://chatgpt.com/backend-api/codex'+p]));
const equal = (a,b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export async function startServer({port=8787, credentials, transport=requestUpstream, controlToken, instanceId = 'fixture', onStop=()=>{}, onSelect=null, routingStatus=()=>undefined, usageStatus=null, refreshUsage=null, setReserveUsage=null, maxBytes=DEFAULT_LIMITS.max_request_bytes, timeoutMs=DEFAULT_LIMITS.idle_timeout_ms, maxHeaderBytes=DEFAULT_LIMITS.max_header_bytes}) {
  const limits = validateLimits({ max_request_bytes: maxBytes, idle_timeout_ms: timeoutMs, max_header_bytes: maxHeaderBytes });
  const active = new Set();
  let selecting = false;
  const server = http.createServer({ maxHeaderSize: maxHeaderBytes }, async (req,res) => {
    const fail = (status, code) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(status, {'content-type':'application/json','cache-control':'no-store'});
      if (!req.complete) { res.shouldKeepAlive = false; res.once('finish', () => req.destroy()); }
      res.end(JSON.stringify({error:{type:'codex_gateway_error',code,message:code}}));
    };
    if(req.headers.origin || req.headers.host !== `127.0.0.1:${server.address()?.port}`) return fail(403,'local_client_required');
    if(req.url === '/health' && req.method === 'GET') { res.setHeader('content-type','application/json'); return res.end(JSON.stringify({service:'codex-gateway',version:'0.1.0'})); }
    if (req.url === '/control/usage' && ['GET', 'POST'].includes(req.method)) {
      if (!controlToken || !equal(req.headers.authorization, `Bearer ${controlToken}`)) return fail(403, 'invalid_control_token');
      if (!usageStatus || !refreshUsage) return fail(501, 'usage_status_unavailable');
      try {
        if (req.method === 'POST') void refreshUsage();
        const usage = await usageStatus();
        const body = JSON.stringify({ instanceId, usage_status: usage, routing: routingStatus() });
        if (Buffer.byteLength(body) > 1024 * 1024) return fail(503, 'usage_status_unavailable');
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      } catch { fail(503, 'usage_status_unavailable'); }
      return;
    }
    const reserve = /^\/control\/reserve-usage\/(true|false)$/.exec(req.url);
    if (reserve && req.method === 'POST') {
      if (!controlToken || !equal(req.headers.authorization, `Bearer ${controlToken}`)) return fail(403, 'invalid_control_token');
      if (!setReserveUsage) return fail(501, 'reserve_usage_unavailable');
      try {
        const routing = await setReserveUsage(reserve[1] === 'true');
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify({ instanceId, routing }));
      } catch { fail(503, 'reserve_usage_unavailable'); }
      return;
    }
    if ((req.url === '/control/stop' && req.method === 'POST') || (req.url === '/control/status' && req.method === 'GET')) {
      if(!controlToken || !equal(req.headers.authorization,`Bearer ${controlToken}`)) return fail(403,'invalid_control_token');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ instanceId, routing: routingStatus(), limits, active_requests: active.size }));
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
    const queryAt = req.url.indexOf('?');
    const path = queryAt < 0 ? req.url : req.url.slice(0, queryAt);
    const target = routes.get(path);
    const url = target && target + (queryAt < 0 ? '' : req.url.slice(queryAt));
    if(req.method !== 'POST' || !url) return fail(404,'unsupported_route');
    if (Number(req.headers['content-length']) > maxBytes) return fail(413, 'request_too_large');
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
    const progress = () => { if (!controller.signal.aborted) timer.refresh(); };
    req.on('aborted',()=>controller.abort());
    res.on('close',()=>{if(!res.writableFinished) controller.abort();});
    try {
      // Do not decode, parse, or buffer conversations. The upstream owns schema,
      // model, compression and streaming validation; the gateway counts wire bytes.
      async function* body() {
        let size = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > maxBytes) {
            fail(413, 'request_too_large');
            controller.abort();
            throw new Error('request_too_large');
          }
          progress();
          yield chunk;
        }
        progress();
      }
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
      const upstream=await transport(url,{method:'POST',headers,body:body(),signal:controller.signal,redirect:'error',maxHeaderSize:maxHeaderBytes});
      controller.signal.throwIfAborted();
      progress();
      // Preserve upstream error codes and bodies too: the client uses them for
      // context recovery and rate-limit handling. Nothing is logged or replayed.
      const responseHeaders={'cache-control':'no-store'};
      for(const name of responseHeadersToForward) if(upstream.headers.has(name)) responseHeaders[name]=upstream.headers.get(name);
      res.writeHead(upstream.status,responseHeaders);
      res.flushHeaders();
      if(upstream.body) for await(const chunk of upstream.body) {
        progress();
        if(!res.write(chunk)) await once(res,'drain',{signal:controller.signal});
        progress();
      }
      res.end();
    } catch { if(!res.headersSent) fail(controller.signal.aborted?504:502,controller.signal.aborted?'upstream_timeout':'upstream_unavailable'); else res.destroy(); }
    finally {
      clearTimeout(timer);
      controller.abort();
      if (!req.complete) { if (res.writableFinished) req.destroy(); else res.once('finish', () => req.destroy()); }
      active.delete(abort);
    }
  });
  server.on('upgrade', (req, socket) => {
    // Codex treats 426 as an immediate HTTP fallback; a 404 triggers retries.
    const local = !req.headers.origin && req.headers.host === `127.0.0.1:${server.address()?.port}`;
    const responses = req.method === 'GET' && req.url.split('?')[0] === '/v1/responses' && req.headers.upgrade?.toLowerCase() === 'websocket';
    const status = !local ? '403 Forbidden' : responses ? '426 Upgrade Required' : '404 Not Found';
    socket.on('error', () => socket.destroy());
    socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`);
    socket.destroySoon();
  });
  // Node's requestTimeout is a total upload deadline. Our progress timer handles
  // stalled uploads and streams without cutting off healthy long requests.
  server.requestTimeout=0; server.headersTimeout=60000;
  server.listen(port,'127.0.0.1'); await once(server,'listening');
  return { port:server.address().port, close:()=>new Promise(resolve=>{for (const abort of active) abort(); server.close(resolve);server.closeAllConnections();}) };
}
