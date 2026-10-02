import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import net from 'node:net';
import http from 'node:http';
import { buffer } from 'node:stream/consumers';
import { once } from 'node:events';
import { startServer } from '../src/server.mjs';
import { requestUpstream } from '../src/transport.mjs';
const auth=async()=>({token:'backing-fixture',account:'fixture-account'});
const body={model:'fixture-model',stream:true,input:[],reasoning:{effort:'low'}};
test('WebSocket negotiation requests immediate HTTP fallback without selecting an account', async () => {
  let authCalls = 0, upstreamCalls = 0;
  const s = await startServer({ port: 0, credentials: async () => { authCalls++; return auth(); },
    transport: async () => { upstreamCalls++; return new Response('fixture'); } });
  const handshake = (path = '/v1/responses', extra = '', host = `127.0.0.1:${s.port}`) => new Promise((resolve, reject) => {
    const socket = net.connect(s.port, '127.0.0.1');
    let reply = '';
    socket.setTimeout(1000, () => socket.destroy(new Error('handshake did not close')));
    socket.on('error', reject);
    socket.on('data', chunk => { reply += chunk; });
    socket.on('end', () => resolve(reply));
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: Zml4dHVyZS1maXh0dXJlIQ==\r\n${extra}\r\n`));
  });
  try {
    assert.match(await handshake(), /^HTTP\/1\.1 426 Upgrade Required\r\n/);
    assert.match(await handshake('/v1/responses', 'Origin: https://example.test\r\n'), /^HTTP\/1\.1 403 /);
    assert.match(await handshake('/v1/responses', '', `example.test:${s.port}`), /^HTTP\/1\.1 403 /);
    assert.match(await handshake('/control/stop'), /^HTTP\/1\.1 404 /);
    assert.equal(authCalls, 0);
    assert.equal(upstreamCalls, 0);
    const response = await fetch(`http://127.0.0.1:${s.port}/v1/responses`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(await response.text(), 'fixture');
    assert.equal(authCalls, 1);
    assert.equal(upstreamCalls, 1);
  } finally { await s.close(); }
});
test('rejects browser origins and unexpected hosts before resolving credentials', async () => {
  let authCalls = 0;
  const server = await startServer({ port: 0, credentials: async () => {
    authCalls++; throw new Error('Blocked requests must not resolve credentials');
  } });
  try {
    for (const headers of [{ origin: 'https://example.test' }, { host: 'example.test' }]) {
      const response = await new Promise((resolve, reject) => {
        const request = http.request(`http://127.0.0.1:${server.port}/v1/responses`, {
          method: 'POST', headers, agent: false, signal: AbortSignal.timeout(1000),
        }, async response => {
          try { resolve({ status: response.statusCode, body: JSON.parse(await buffer(response)) }); }
          catch (error) { reject(error); }
        });
        request.on('error', reject); request.end('{}');
      });
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'local_client_required');
    }
    assert.equal(authCalls, 0);
  } finally { await server.close(); }
});
test('control endpoint requires its private token',async()=>{
  let stopped=false;const s=await startServer({port:0,credentials:auth,controlToken:'test-token',onStop:()=>{stopped=true;}});
  try{const url=`http://127.0.0.1:${s.port}/control/stop`;assert.equal((await fetch(url,{method:'POST'})).status,403);assert.equal(stopped,false);const r=await fetch(url,{method:'POST',headers:{authorization:'Bearer test-token'}});await r.text();assert.equal(r.status,200);await new Promise(setImmediate);assert.equal(stopped,true);}finally{await s.close();}
});

test('shared usage reads require control auth and refresh returns while polling is pending', async () => {
  let refreshes = 0;
  const s = await startServer({ port: 0, credentials: auth, controlToken: 'fixture-control',
    usageStatus: async () => ({ checking: refreshes > 0, accounts: [] }),
    refreshUsage: () => { refreshes++; return new Promise(() => {}); } });
  const url = `http://127.0.0.1:${s.port}/control/usage`;
  try {
    for (const method of ['GET', 'POST']) assert.equal((await fetch(url, { method })).status, 403);
    assert.equal(refreshes, 0);
    const headers = { authorization: 'Bearer fixture-control' };
    const initial = await fetch(url, { headers });
    assert.equal((await initial.json()).usage_status.checking, false);
    assert.equal(refreshes, 0);
    const refreshed = await fetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(1000) });
    assert.equal(refreshed.status, 200);
    assert.equal((await refreshed.json()).usage_status.checking, true);
    assert.equal(refreshes, 1);
    assert.equal((await fetch(url, { headers: { ...headers, origin: 'https://example.test' } })).status, 403);
  } finally { await s.close(); }
});

test('account changes require control auth, refuse in-flight work, and gate new requests during selection', async () => {
  let began, release, selected = 'before', switchStarted, finishSwitch;
  const ready = new Promise(r => began = r), pending = new Promise(r => release = r);
  const selecting = new Promise(r => switchStarted = r), selection = new Promise(r => finishSwitch = r);
  const server = await startServer({port:0,controlToken:'fixture',credentials:async()=>({token:selected,account:selected}),
    onSelect:async()=>{switchStarted();await selection;selected='after';},
    transport:async(_, opts)=>{assert.equal(opts.headers.get('authorization'),'Bearer before');began();await pending;return new Response('done');}});
  const url=`http://127.0.0.1:${server.port}`;
  const change = headers => fetch(url+'/control/account/default',{method:'POST',headers});
  const request = () => fetch(url+'/v1/responses',{method:'POST',body:JSON.stringify(body)});
  try {
    assert.equal((await change({})).status,403);
    const work=request();await ready;
    const busy=await change({authorization:'Bearer fixture'});assert.equal(busy.status,409);assert.equal((await busy.json()).code,'gateway_busy');
    release();await (await work).text();
    const switching=change({authorization:'Bearer fixture'});await selecting;
    assert.equal((await request()).status,503);
    finishSwitch();assert.equal((await switching).status,200);assert.equal(selected,'after');
  } finally {release();finishSwitch();await server.close();}
});

async function nativeFixture(handler, run, options = {}) {
  const upstream = http.createServer({ maxHeaderSize: 1024 * 1024 }, (req, res) => {
    Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const gateway = await startServer({ port: 0, credentials: auth, ...options,
    transport: (url, opts) => {
      const target = new URL(url);
      return requestUpstream(`http://127.0.0.1:${upstream.address().port}${target.pathname}${target.search}`, opts);
    },
  });
  try { await run(`http://127.0.0.1:${gateway.port}`, gateway); }
  finally {
    await gateway.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
}

test('native transport accepts image-heavy bodies above 16 MiB, plain/gzip/zstd, byte for byte', { timeout: 15000 }, async () => {
  const large = Buffer.from(JSON.stringify({ ...body, input: 'fixture-image'.repeat(1_500_000) }));
  assert.ok(large.length > 16 * 1024 * 1024);
  let expected, calls = 0;
  await nativeFixture(async (req, res) => {
    const received = await buffer(req);
    assert.deepEqual(received, expected);
    assert.equal(req.headers.authorization, 'Bearer backing-fixture');
    assert.equal(req.headers['chatgpt-account-id'], 'fixture-account');
    for (const name of ['x-api-key', 'x-openai-actor-authorization']) assert.equal(req.headers[name], undefined);
    assert.equal(req.headers['session-id'], 'session');
    assert.equal(req.headers['thread-id'], 'thread');
    calls++; res.end('accepted');
  }, async url => {
    for (const [encoding, bytes] of [['identity', large], ['gzip', gzipSync(large)], ['zstd', zstdCompressSync(large)]]) {
      expected = bytes;
      const response = await fetch(url + '/v1/responses', { method: 'POST', body: bytes,
        headers: { 'content-encoding': encoding, authorization: 'Bearer caller', 'x-api-key': 'caller-key',
          'x-openai-actor-authorization': 'marker', 'session-id': 'session', 'thread-id': 'thread' },
        signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200); assert.equal(await response.text(), 'accepted');
    }
    assert.equal(calls, 3);
  });
});

test('schema, streaming mode, multipart, encoding and query parameters are upstream-owned', async () => {
  let nested = {}; for (let i = 0; i < 100; i++) nested = { child: nested };
  const cases = [
    ['responses', JSON.stringify({ model: 'm'.repeat(300), stream: false, input: nested }), 'application/json', 'identity'],
    ['responses/compact?feature=a%2Fb&feature=c', '{', 'application/json', 'identity'],
    ['images/generations', '{}', 'application/json', 'identity'],
    ['alpha/search', '{}', 'application/json', 'identity'],
    ['images/edits', '--fixture\r\nopaque-image\r\n--fixture--', 'multipart/form-data; boundary=fixture', 'future-encoding'],
  ];
  let index = 0;
  await nativeFixture(async (req, res) => {
    const [path, text, type, encoding] = cases[index++];
    assert.equal(req.url, '/backend-api/codex/' + path);
    assert.equal((await buffer(req)).toString(), text);
    assert.equal(req.headers['content-type'], type); assert.equal(req.headers['content-encoding'], encoding);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"context_length_exceeded","message":"Fixture context is full"}}');
  }, async url => {
    for (const [path, body, type, encoding] of cases) {
      const response = await fetch(url + '/v1/' + path, { method: 'POST', body,
        headers: { 'content-type': type, 'content-encoding': encoding } });
      assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'context_length_exceeded');
    }
    assert.equal(index, cases.length);
  });
});

test('native forwarding preserves large turn-state headers and compressed response bytes', async () => {
  const incomingState = 'a'.repeat(32768), outgoingState = 'b'.repeat(65536);
  const compressed = gzipSync('data: fixture\n\n');
  await nativeFixture(async (req, res) => {
    assert.equal(req.headers['x-codex-turn-state'], incomingState);
    await buffer(req);
    res.writeHead(200, { 'x-codex-turn-state': outgoingState, 'content-encoding': 'gzip',
      'content-length': compressed.length, 'content-type': 'text/event-stream' });
    res.end(compressed);
  }, async url => {
    const result = await new Promise((resolve, reject) => {
      const request = http.request(url + '/v1/responses', { method: 'POST', maxHeaderSize: 1024 * 1024,
        headers: { 'x-codex-turn-state': incomingState } }, async response => {
        try { resolve({ headers: response.headers, body: await buffer(response) }); } catch (error) { reject(error); }
      });
      request.on('error', reject); request.end('{}');
    });
    assert.equal(result.headers['x-codex-turn-state'], outgoingState);
    assert.equal(result.headers['content-encoding'], 'gzip'); assert.deepEqual(result.body, compressed);
  });
});

test('progressing uploads and responses outlive the idle timeout', { timeout: 5000 }, async () => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  await nativeFixture(async (req, res) => {
    assert.equal((await buffer(req)).toString(), 'x'.repeat(10));
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    for (let i = 0; i < 10; i++) { res.write('data: fixture\n\n'); await delay(50); }
    res.end();
  }, async url => {
    const start = Date.now();
    const response = await fetch(url + '/v1/responses', { method: 'POST', duplex: 'half',
      body: (async function* () { for (let i = 0; i < 10; i++) { yield 'x'; await delay(50); } })(),
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, 200); assert.equal(await response.text(), 'data: fixture\n\n'.repeat(10));
    assert.ok(Date.now() - start > 800);
  }, { timeoutMs: 300 });
});

test('idle uploads, upstream headers and response bodies time out and close sockets', { timeout: 5000 }, async () => {
  for (const phase of ['upload', 'headers', 'body']) {
    const closed = Promise.withResolvers();
    await nativeFixture(async (req, res) => {
      res.once('close', closed.resolve);
      await buffer(req);
      if (phase === 'body') { res.writeHead(200); res.write('partial'); }
    }, async url => {
      if (phase === 'upload') {
        const response = await new Promise((resolve, reject) => {
          const request = http.request(url + '/v1/responses', { method: 'POST' }, resolve);
          request.on('error', reject);
          request.write('partial'); // Deliberately never finish the upload.
        });
        assert.equal(response.statusCode, 504);
        assert.equal(JSON.parse(await buffer(response)).error.code, 'upstream_timeout');
      } else {
        const response = await fetch(url + '/v1/responses', { method: 'POST', body: '{}', signal: AbortSignal.timeout(2000) });
        if (phase === 'body') { assert.equal(response.status, 200); await assert.rejects(response.text()); }
        else { assert.equal(response.status, 504); assert.equal((await response.json()).error.code, 'upstream_timeout'); }
      }
      await closed.promise;
    }, { timeoutMs: 100 });
  }
});

test('wire-size cap rejects known and chunked oversized uploads with an explicit 413', { timeout: 5000 }, async () => {
  let calls = 0;
  const closed = Promise.withResolvers();
  await nativeFixture(async (req, res) => {
    calls++; res.once('close', closed.resolve);
    await buffer(req); res.end('unexpected');
  }, async url => {
    const known = await fetch(url + '/v1/responses', { method: 'POST', body: 'x'.repeat(2048) });
    assert.equal(known.status, 413); assert.equal((await known.json()).error.code, 'request_too_large');
    assert.equal(calls, 0);
    const chunked = await fetch(url + '/v1/responses', { method: 'POST', duplex: 'half',
      body: (async function* () { yield 'x'.repeat(512); await new Promise(resolve => setTimeout(resolve, 50)); yield 'x'.repeat(1024); })(),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(chunked.status, 413); assert.equal((await chunked.json()).error.code, 'request_too_large');
    await closed.promise;
  }, { maxBytes: 1024 });
});

test('native transport never follows redirects or forwards upstream cookies', async () => {
  let calls = 0;
  await nativeFixture(async (req, res) => {
    await buffer(req); calls++;
    res.writeHead(307, { location: 'http://127.0.0.1:1/credential-trap', 'set-cookie': 'fixture=private' });
    res.end('redirect');
  }, async url => {
    const response = await fetch(url + '/v1/responses', { method: 'POST', body: '{}' });
    assert.equal(response.status, 307); assert.equal(await response.text(), 'redirect');
    assert.equal(response.headers.get('location'), null); assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(calls, 1);
  });
});

test('native streaming starts before upload completion and cancels when the client disconnects', { timeout: 5000 }, async () => {
  const arrived = Promise.withResolvers(), closed = Promise.withResolvers();
  await nativeFixture(async (req, res) => {
    res.once('close', closed.resolve);
    req.once('data', arrived.resolve);
    await buffer(req);
  }, async url => {
    const request = http.request(url + '/v1/responses', { method: 'POST' });
    request.on('error', () => {});
    request.write('partial');
    await arrived.promise;
    // A buffered implementation cannot reach this point until request.end().
    const health = await fetch(url + '/health'); assert.equal(health.status, 200);
    request.destroy();
    await closed.promise;
  });
});

test('upstream errors retain their status, body and retry guidance without replay', async () => {
  for (const status of [400, 401, 429]) {
    const body = JSON.stringify({ error: { code: 'fixture-error', message: 'unchanged detail' } });
    let calls = 0;
    await nativeFixture(async (req, res) => {
      await buffer(req); calls++;
      res.writeHead(status, { 'retry-after': '60', 'x-request-id': 'fixture' });
      res.end(body);
    }, async url => {
      const response = await fetch(url + '/v1/responses', { method: 'POST', body: '{}' });
      assert.equal(response.status, status);
      assert.equal(response.headers.get('retry-after'), '60');
      assert.equal(response.headers.get('x-request-id'), 'fixture');
      assert.equal(await response.text(), body);
      assert.equal(calls, 1);
    });
  }
});

test('client cancellation and gateway shutdown close active upstream work', { timeout: 5000 }, async () => {
  for (const shutdown of [false, true]) {
    const began = Promise.withResolvers(), closed = Promise.withResolvers();
    await nativeFixture(async (req, res) => {
      res.once('close', closed.resolve);
      await buffer(req);
      if (!shutdown) { res.writeHead(200); res.write('partial'); }
      began.resolve();
    }, async (url, gateway) => {
      const controller = new AbortController();
      const pending = fetch(url + '/v1/responses', { method: 'POST', body: '{}', signal: controller.signal });
      if (shutdown) {
        const failed = assert.rejects(pending);
        await began.promise;
        await gateway.close();
        await failed;
      } else {
        const response = await pending;
        await response.body.getReader().read();
        controller.abort();
      }
      await closed.promise;
    });
  }
});
