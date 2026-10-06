import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buffer } from 'node:stream/consumers';
import { gzipSync } from 'node:zlib';
import { startServer } from '../src/server.mjs';
import { requestUpstream, upgradeUpstream } from '../src/transport.mjs';
import { readAuth } from '../src/state.mjs';
import { REALTIME_CALL_PATH } from '../src/realtime.mjs';

const key = 'Zml4dHVyZS1maXh0dXJlIQ==';
const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
const headers = { 'openai-alpha': 'quicksilver=v2', 'x-session-id': 'fixture-session', 'session-id': 'fixture-session', 'thread-id': 'fixture-thread', originator: 'codex-fixture', 'x-codex-turn-metadata': 'fixture-metadata', 'x-oai-attestation': 'fixture-attestation' };
const turn = Buffer.from('{"sdp":"fixture-offer","session":{"model":"gpt-live-1-codex","instructions":"fixture"}}');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await delay(5); }
  assert.fail('fixture condition not reached');
}

// Only ephemeral loopback upstreams and newly written fake backing profiles.
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-gateway-voice-')));
  for (const name of ['a', 'b']) {
    await mkdir(join(root, name, 'codex'), { recursive: true, mode: 0o700 });
    await writeFile(join(root, name, 'codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: `fixture-${name}`, account_id: `account-${name}` } }), { mode: 0o600 });
  }
  let selected = 'a', authCalls = 0, sequence = 0;
  const httpCalls = [], wsCalls = [], sockets = new Set();
  const backend = http.createServer((req, res) => { void (async () => {
    req.on('error', () => {});
    const call = { req, res, headers: req.headers, path: req.url };
    httpCalls.push(call);
    if (options.http) return options.http(call);
    call.body = await buffer(req);
    if (req.url.startsWith(REALTIME_CALL_PATH)) {
      res.writeHead(201, { location: `/v1/live/rtc_fixture_${++sequence}`, 'content-type': 'application/sdp', 'set-cookie': 'fixture-private' });
      res.end('fixture-answer');
    } else res.end('fixture-chat');
  })().catch(() => res.destroy()); });
  backend.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  backend.on('upgrade', (req, socket, head) => {
    socket.once('end', () => socket.end());
    const call = { req, socket, head, headers: req.headers, path: req.url, chunks: head.length ? [head] : [] };
    wsCalls.push(call);
    socket.on('data', chunk => call.chunks.push(chunk));
    if (options.ws) return options.ws(call);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: fixture-private\r\n\r\n`);
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const local = url => `http://127.0.0.1:${backend.address().port}${new URL(url).pathname}${new URL(url).search}`;
  const gateway = await startServer({ port: 0, controlToken: 'fixture-control',
    credentials: async () => { authCalls++; return readAuth(join(root, selected), { create: false }); },
    transport: (url, opts) => { assert.equal(new URL(url).origin, 'https://chatgpt.com'); return requestUpstream(local(url), opts); },
    upgradeTransport: (url, opts) => { assert.equal(new URL(url).origin, 'wss://api.openai.com'); return upgradeUpstream(local(url), opts); },
    onSelect: async () => { selected = 'b'; }, ...options.server,
  });
  t.after(async () => {
    await gateway.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => backend.close(resolve)); await rm(root, { recursive: true, force: true });
  });
  const post = (body = turn, extra = {}, path = REALTIME_CALL_PATH) => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${gateway.port}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...extra }, agent: false, signal: AbortSignal.timeout(2000) }, async res => {
      try { resolve({ status: res.statusCode, headers: res.headers, body: await buffer(res) }); } catch (e) { reject(e); }
    });
    req.on('error', reject); req.end(body);
  });
  const control = async (path = 'status', method = 'GET') => {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/control/${path}`, { method, headers: { authorization: 'Bearer fixture-control' } });
    return { status: res.status, body: await res.json() };
  };
  return { gateway, root, httpCalls, wsCalls, post, control, select: () => { selected = 'b'; }, authCalls: () => authCalls };
}

async function handshake(t, gateway, { path = '/v1/live/rtc_fixture_1', extra = {}, head = Buffer.alloc(0), host = `127.0.0.1:${gateway.port}`, method = 'GET' } = {}) {
  const socket = net.connect(gateway.port, '127.0.0.1');
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  let received = Buffer.alloc(0), parsed = false;
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fixture handshake timeout')), 2000);
    socket.on('data', chunk => {
      received = Buffer.concat([received, chunk]);
      if (parsed) return;
      const index = received.indexOf('\r\n\r\n'); if (index < 0) return;
      parsed = true; clearTimeout(timer);
      const lines = received.subarray(0, index).toString().split('\r\n');
      received = received.subarray(index + 4);
      const responseHeaders = Object.fromEntries(lines.slice(1).map(line => { const index = line.indexOf(':'); return [line.slice(0, index).toLowerCase(), line.slice(index + 1).trim()]; }));
      resolve({ status: Number(lines[0].split(' ')[1]), headers: responseHeaders, socket,
        read: async length => { await waitFor(() => received.length >= length); const bytes = received.subarray(0, length); received = received.subarray(length); return bytes; },
      });
    });
    socket.once('close', () => { if (!parsed) { clearTimeout(timer); reject(new Error('fixture handshake canceled')); } });
  });
  await once(socket, 'connect');
  const requestHeaders = { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key, ...headers, ...extra };
  const lines = Object.entries(requestHeaders).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  socket.write(Buffer.concat([Buffer.from(`${method} ${path} HTTP/1.1\r\n${lines}\r\n\r\n`), head]));
  return response;
}

// RFC 6455 text fragment, binary, ping/pong and close fixtures, already masked.
const clientFrames = Buffer.from('01820102030469678083010203046d6e6c82820102030401fd898101020304618a81010203046188820102030402ea', 'hex');
const serverFrames = Buffer.from('81026869890370696e8a03706f6e880203e8', 'hex');

test('v3 call creation preserves JSON/compressed bytes, query, SDP, Location and required headers', async t => {
  const f = await fixture(t);
  const compressed = gzipSync(turn);
  const result = await f.post(compressed, { authorization: 'Bearer caller-fixture', 'chatgpt-account-id': 'caller-account', cookie: 'caller-cookie', 'content-encoding': 'gzip', 'content-length': compressed.length }, REALTIME_CALL_PATH + '?intent=quicksilver&architecture=avas&opaque=a%2Fb');
  assert.equal(result.status, 201); assert.equal(result.body.toString(), 'fixture-answer');
  assert.equal(result.headers.location, '/v1/live/rtc_fixture_1'); assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['cache-control'], 'no-store');
  const call = f.httpCalls[0]; assert.equal(call.path, REALTIME_CALL_PATH + '?intent=quicksilver&architecture=avas&opaque=a%2Fb');
  assert.deepEqual(call.body, compressed);
  for (const [name, value] of Object.entries(headers)) assert.equal(call.headers[name], value);
  assert.equal(call.headers.authorization, 'Bearer fixture-a'); assert.equal(call.headers['chatgpt-account-id'], 'account-a');
  assert.equal(call.headers.cookie, undefined); assert.equal(call.headers['content-encoding'], 'gzip'); assert.equal(call.headers['accept-encoding'], 'identity');
});

test('control forwards untouched frames and handshake heads both ways without credential/cookie leakage', async t => {
  const f = await fixture(t, { ws: ({ socket }) => socket.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: fixture-private\r\n\r\n`), serverFrames])) });
  await f.post();
  const ws = await handshake(t, f.gateway, { path: '/v1/live/rtc_fixture_1?opaque=a%2Fb', head: clientFrames.subarray(0, 3), extra: { authorization: 'Bearer caller-fixture', 'chatgpt-account-id': 'caller-account', cookie: 'caller-cookie' } });
  assert.equal(ws.status, 101); assert.equal(ws.headers['set-cookie'], undefined);
  assert.deepEqual(await ws.read(serverFrames.length), serverFrames);
  ws.socket.write(clientFrames.subarray(3, 11)); ws.socket.write(clientFrames.subarray(11));
  await waitFor(() => Buffer.concat(f.wsCalls[0].chunks).length === clientFrames.length);
  assert.deepEqual(Buffer.concat(f.wsCalls[0].chunks), clientFrames);
  const call = f.wsCalls[0]; assert.equal(call.path, '/v1/live/rtc_fixture_1?opaque=a%2Fb');
  for (const [name, value] of Object.entries(headers)) assert.equal(call.headers[name], value);
  assert.equal(call.headers.authorization, 'Bearer fixture-a'); assert.equal(call.headers['chatgpt-account-id'], 'account-a'); assert.equal(call.headers.cookie, undefined);
  assert.equal((await f.control()).body.active_requests, 1);
  assert.equal((await f.control('account/default', 'POST')).body.code, 'gateway_busy');
});

test('reconnect pins original account while chat and new calls use a newly selected account; duplicate joins are refused', async t => {
  const f = await fixture(t); await f.post();
  const first = await handshake(t, f.gateway); assert.equal(first.status, 101);
  assert.equal((await handshake(t, f.gateway)).status, 409); assert.equal(f.wsCalls.length, 1);
  f.select();
  const chat = await f.post(Buffer.from('{}'), {}, '/v1/responses'); assert.equal(chat.body.toString(), 'fixture-chat');
  assert.equal(f.httpCalls[1].headers.authorization, 'Bearer fixture-b');
  first.socket.destroy(); await waitFor(async () => (await f.control()).body.active_requests === 0);
  // Remove original fake profile: reconnect must use the captured binding, not
  // resolve credentials or silently route to another account.
  await rm(join(f.root, 'a'), { recursive: true });
  const calls = f.authCalls(); const again = await handshake(t, f.gateway); assert.equal(again.status, 101);
  assert.equal(f.authCalls(), calls); assert.equal(f.wsCalls[1].headers.authorization, 'Bearer fixture-a');
  await f.post(); const second = await handshake(t, f.gateway, { path: '/v1/live/rtc_fixture_2' }); assert.equal(second.status, 101);
  assert.equal(f.wsCalls[2].headers['chatgpt-account-id'], 'account-b');
});

test('rejects unknown calls, malformed IDs, browser/foreign hosts and incompatible handshakes before resolving credentials', async t => {
  const f = await fixture(t);
  for (const [options, status] of [
    [{}, 404], [{ path: '/v1/live/rtc_%2Fother' }, 404], [{ path: '/v1/live/rtc_ok/other' }, 404],
    [{ extra: { origin: 'https://fixture.test' } }, 403], [{ host: 'fixture.test' }, 403],
    [{ extra: { 'sec-websocket-key': 'invalid' } }, 400], [{ extra: { 'sec-websocket-version': '12' } }, 400],
    [{ extra: { 'openai-alpha': 'quicksilver=v1' } }, 400], [{ extra: { 'sec-websocket-extensions': 'permessage-deflate' } }, 400],
  ]) assert.equal((await handshake(t, f.gateway, options)).status, status);
  assert.equal(f.authCalls(), 0); assert.equal(f.wsCalls.length, 0);
  assert.equal((await f.post(turn, { 'openai-alpha': 'quicksilver=v1' })).status, 400);
  assert.equal((await f.post(turn, {}, '/v1/live')).status, 404);
  assert.equal(f.authCalls(), 0);
});

test('call errors preserve status/body, never follow redirects or forward error Location/cookies', async t => {
  let status = 429;
  const f = await fixture(t, { http: async ({ req, res }) => { await buffer(req); res.writeHead(status, { location: 'https://fixture.invalid/rtc_external', 'set-cookie': 'fixture-private', 'retry-after': '2' }); res.end('fixture-error'); } });
  for (const code of [429, 401, 307]) {
    status = code; const result = await f.post();
    assert.equal(result.status, code); assert.equal(result.body.toString(), 'fixture-error'); assert.equal(result.headers.location, undefined); assert.equal(result.headers['set-cookie'], undefined); assert.equal(result.headers['retry-after'], '2');
  }
  assert.equal(f.httpCalls.length, 3); assert.equal((await handshake(t, f.gateway, { path: '/v1/live/rtc_external' })).status, 404);
});

test('invalid/missing/duplicate call Location cannot create or replace an account binding', async t => {
  let location;
  const f = await fixture(t, { http: async ({ req, res }) => { await buffer(req); res.writeHead(201, location ? { location } : {}); res.end('fixture-answer'); } });
  for (const value of [undefined, '/v1/live', '/v1/live/rtc_%2Finvalid']) { location = value; assert.equal((await f.post()).status, 502); }
  location = '/v1/live/rtc_fixture_1'; assert.equal((await f.post()).status, 201);
  f.select(); assert.equal((await f.post()).status, 502);
  assert.equal((await handshake(t, f.gateway)).status, 101); assert.equal(f.wsCalls[0].headers['chatgpt-account-id'], 'account-a');
});

test('UUID and backend-forwarded call Locations bind their control IDs', async t => {
  const id = '019eb97d-8e9a-7ff3-94b0-ea019babd5d7';
  const f = await fixture(t, { http: async ({ req, res }) => { await buffer(req); res.writeHead(201, { location: `https://fixture.test/v1/realtime/calls/calls/${id}?opaque=1` }); res.end('fixture-answer'); } });
  const result = await f.post(); assert.equal(result.headers.location, `https://fixture.test/v1/realtime/calls/calls/${id}?opaque=1`);
  assert.equal((await handshake(t, f.gateway, { path: `/v1/live/${id}` })).status, 101);
});

test('upstream handshake errors preserve status/body and terminal errors remove the binding', async t => {
  let status = 429;
  const f = await fixture(t, { ws: ({ socket }) => socket.end(`HTTP/1.1 ${status} Error\r\nContent-Length: 13\r\nContent-Type: text/plain\r\nRetry-After: 2\r\nLocation: https://fixture.invalid\r\nSet-Cookie: fixture-private\r\n\r\nfixture-error`) });
  await f.post();
  const rate = await handshake(t, f.gateway); assert.equal(rate.status, 429); assert.equal((await rate.read(13)).toString(), 'fixture-error'); assert.equal(rate.headers['retry-after'], '2'); assert.equal(rate.headers.location, undefined); assert.equal(rate.headers['set-cookie'], undefined);
  await waitFor(async () => (await f.control()).body.active_requests === 0);
  status = 410; const gone = await handshake(t, f.gateway); assert.equal(gone.status, 410); assert.equal((await gone.read(13)).toString(), 'fixture-error');
  assert.equal((await handshake(t, f.gateway)).status, 404); assert.equal(f.wsCalls.length, 2);
});

test('invalid upstream WebSocket acceptance fails closed and releases the join for a client retry', async t => {
  let bad = true;
  const f = await fixture(t, { ws: ({ socket }) => socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${bad ? 'invalid' : accept}\r\n\r\n`) });
  await f.post(); assert.equal((await handshake(t, f.gateway)).status, 502);
  await waitFor(async () => (await f.control()).body.active_requests === 0);
  bad = false; assert.equal((await handshake(t, f.gateway)).status, 101); assert.equal(f.wsCalls.length, 2);
});

test('capacity includes pending creations; failed calls release capacity and expiry frees bindings', async t => {
  let release;
  const blocked = new Promise(resolve => release = resolve);
  let first = true;
  const f = await fixture(t, { server: { realtimeOptions: { maxCalls: 1, callTtlMs: 250 } }, http: async ({ req, res }) => {
    await buffer(req); if (first) { first = false; await blocked; res.writeHead(503); res.end('fixture-error'); }
    else { res.writeHead(201, { location: '/v1/live/rtc_fixture_1' }); res.end('fixture-answer'); }
  } });
  const initial = f.post(); await waitFor(() => f.httpCalls.length === 1);
  assert.equal((await f.post()).status, 429); assert.equal(f.authCalls(), 1);
  release(); assert.equal((await initial).status, 503);
  assert.equal((await f.post()).status, 201); assert.equal((await f.post()).status, 429);
  const live = await handshake(t, f.gateway); assert.equal(live.status, 101);
  await waitFor(() => live.socket.destroyed); assert.equal((await handshake(t, f.gateway)).status, 404);
  assert.equal((await f.control()).body.active_requests, 0); assert.equal((await f.post()).status, 201);
});

test('client cancellation of call creation aborts the upstream and releases pending capacity', async t => {
  const f = await fixture(t, { server: { realtimeOptions: { maxCalls: 1 } }, http: async ({ req }) => { await buffer(req); } });
  const req = http.request(`http://127.0.0.1:${f.gateway.port}${REALTIME_CALL_PATH}`, { method: 'POST', headers, agent: false }); req.on('error', () => {}); req.end(turn);
  await waitFor(() => f.httpCalls.length === 1); req.destroy();
  await waitFor(() => f.httpCalls[0].res.destroyed);
  await waitFor(async () => (await f.control()).body.active_requests === 0);
  // A second request reaches the fake upstream, proving the pending slot is free.
  const next = http.request(`http://127.0.0.1:${f.gateway.port}${REALTIME_CALL_PATH}`, { method: 'POST', headers, agent: false }); next.on('error', () => {}); next.end(turn);
  await waitFor(() => f.httpCalls.length === 2); next.destroy();
});

test('client cancellation during handshake cancels upstream and permits reconnect without re-authentication', async t => {
  let stall = true;
  const f = await fixture(t, { ws: ({ socket }) => { if (!stall) socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`); } });
  await f.post();
  const req = http.request(`http://127.0.0.1:${f.gateway.port}/v1/live/rtc_fixture_1`, { headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' }, agent: false }); req.on('error', () => {}); req.end();
  await waitFor(() => f.wsCalls.length === 1); req.destroy();
  await waitFor(() => f.wsCalls[0].socket.destroyed); await waitFor(async () => (await f.control()).body.active_requests === 0);
  stall = false; assert.equal((await handshake(t, f.gateway)).status, 101); assert.equal(f.authCalls(), 1);
});

test('control byte cap covers early and later frames; overflow closes both peers without replay', async t => {
  const f = await fixture(t, { server: { maxBytes: 128 } }); await f.post();
  assert.equal((await handshake(t, f.gateway, { head: Buffer.alloc(129) })).status, 413); assert.equal(f.wsCalls.length, 0);
  const live = await handshake(t, f.gateway, { head: Buffer.alloc(64, 1) }); assert.equal(live.status, 101);
  live.socket.write(Buffer.alloc(65, 2));
  await waitFor(() => live.socket.destroyed); await waitFor(() => f.wsCalls[0].socket.destroyed);
  assert.equal(Buffer.concat(f.wsCalls[0].chunks).length, 64);
  assert.equal((await f.control()).body.active_requests, 0); assert.equal(f.wsCalls.length, 1);
});

test('idle handshakes time out; control progress extends the idle deadline and shutdown closes upgraded peers', async t => {
  let stall = true;
  const f = await fixture(t, { server: { timeoutMs: 120 }, ws: ({ socket }) => { if (!stall) socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`); } });
  await f.post(); assert.equal((await handshake(t, f.gateway)).status, 504);
  await waitFor(() => f.wsCalls[0].socket.destroyed);
  stall = false; const live = await handshake(t, f.gateway); assert.equal(live.status, 101);
  for (let i = 0; i < 4; i++) { await delay(45); f.wsCalls[1].socket.write(Buffer.from([0x89, 0])); await live.read(2); }
  assert.equal(live.socket.destroyed, false); await f.gateway.close();
  await waitFor(() => live.socket.destroyed); await waitFor(() => f.wsCalls[1].socket.destroyed);
});

test('call uploads retain existing wire-byte limits before and during streaming', async t => {
  const f = await fixture(t, { server: { maxBytes: 8 } });
  assert.equal((await f.post(Buffer.alloc(9), { 'content-length': 9 })).status, 413); assert.equal(f.authCalls(), 0);
  const result = await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${f.gateway.port}${REALTIME_CALL_PATH}`, { method: 'POST', headers, agent: false }, async res => resolve({ status: res.statusCode, body: await buffer(res) }));
    req.on('error', reject); req.write('1234'); req.end('56789');
  });
  assert.equal(result.status, 413); assert.equal(JSON.parse(result.body).error.code, 'request_too_large');
  await waitFor(async () => (await f.control()).body.active_requests === 0);
});

test('abandoned partial SDP responses remove the binding and release capacity', async t => {
  const f = await fixture(t, { server: { realtimeOptions: { maxCalls: 1 } }, http: async ({ req, res }) => {
    await buffer(req); res.writeHead(201, { location: '/v1/live/rtc_fixture_1', 'content-type': 'application/sdp' }); res.write('fixture-partial');
  } });
  const req = http.request(`http://127.0.0.1:${f.gateway.port}${REALTIME_CALL_PATH}`, { method: 'POST', headers, agent: false });
  req.on('error', () => {}); const response = once(req, 'response'); req.end(turn);
  const [res] = await response; res.destroy();
  await waitFor(async () => (await f.control()).body.active_requests === 0);
  assert.equal((await handshake(t, f.gateway)).status, 404);
  const next = http.request(`http://127.0.0.1:${f.gateway.port}${REALTIME_CALL_PATH}`, { method: 'POST', headers, agent: false }); next.on('error', () => {}); next.end(turn);
  await waitFor(() => f.httpCalls.length === 2); next.destroy();
});

test('request and upstream upgrade headers obey the configured cap', async t => {
  const f = await fixture(t, { server: { maxHeaderBytes: 1024 }, ws: ({ socket }) => socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Padding: ${'x'.repeat(2048)}\r\n\r\n`) });
  await f.post(); const authCalls = f.authCalls();
  assert.equal((await handshake(t, f.gateway, { extra: { 'x-padding': 'x'.repeat(2048) } })).status, 431);
  assert.equal(f.authCalls(), authCalls); assert.equal(f.wsCalls.length, 0);
  assert.equal((await handshake(t, f.gateway)).status, 502);
  await waitFor(() => f.wsCalls[0].socket.destroyed);
  assert.equal((await f.control()).body.active_requests, 0);
});

test('control subprotocol selection is forwarded only when offered by the client', async t => {
  let protocol = 'fixture.two';
  const f = await fixture(t, { ws: ({ socket }) => socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`) });
  await f.post(); const first = await handshake(t, f.gateway, { extra: { 'sec-websocket-protocol': 'fixture.one, fixture.two' } });
  assert.equal(first.status, 101); assert.equal(first.headers['sec-websocket-protocol'], 'fixture.two'); assert.equal(f.wsCalls[0].headers['sec-websocket-protocol'], 'fixture.one, fixture.two');
  first.socket.destroy(); await waitFor(async () => (await f.control()).body.active_requests === 0);
  protocol = 'fixture.unoffered'; assert.equal((await handshake(t, f.gateway, { extra: { 'sec-websocket-protocol': 'fixture.one' } })).status, 502);
});

test('upstream EOF delivers its final frames and releases control without losing the reconnect binding', async t => {
  const f = await fixture(t); await f.post(); const ws = await handshake(t, f.gateway);
  f.wsCalls[0].socket.end(serverFrames); assert.deepEqual(await ws.read(serverFrames.length), serverFrames);
  await waitFor(() => ws.socket.destroyed); await waitFor(async () => (await f.control()).body.active_requests === 0);
  assert.equal((await handshake(t, f.gateway)).status, 101);
});

test('idle established control closes both peers; a fresh client reconnect retains the account', async t => {
  const f = await fixture(t, { server: { timeoutMs: 120 } }); await f.post(); const ws = await handshake(t, f.gateway);
  await waitFor(() => ws.socket.destroyed); await waitFor(() => f.wsCalls[0].socket.destroyed);
  assert.equal((await f.control()).body.active_requests, 0); f.select();
  assert.equal((await handshake(t, f.gateway)).status, 101); assert.equal(f.wsCalls[1].headers['chatgpt-account-id'], 'account-a');
});

test('client cancellation after sending control bytes during a stalled handshake promptly cancels upstream', async t => {
  const f = await fixture(t, { ws: () => {} }); await f.post();
  const req = http.request(`http://127.0.0.1:${f.gateway.port}/v1/live/rtc_fixture_1`, { headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' }, agent: false });
  req.on('error', () => {}); req.end();
  await waitFor(() => f.wsCalls.length === 1); req.socket.write(clientFrames);
  await delay(15); req.destroy();
  await waitFor(() => f.wsCalls[0].socket.destroyed);
  await waitFor(async () => (await f.control()).body.active_requests === 0);
});

test('truncated upstream rejection closes the HTTP reply without appending a second response', async t => {
  let status = 429;
  const f = await fixture(t, { ws: ({ socket }) => socket.end(`HTTP/1.1 ${status} Error\r\nContent-Length: 100\r\n\r\nshort`) });
  await f.post(); const ws = await handshake(t, f.gateway); assert.equal(ws.status, 429);
  let tail = ''; ws.socket.on('data', chunk => tail += chunk.toString());
  await waitFor(() => ws.socket.destroyed); assert.doesNotMatch(tail, /HTTP\/1\.1|codex_gateway_error/);
  assert.equal((await f.control()).body.active_requests, 0);
  status = 401;
  const terminal = await handshake(t, f.gateway); assert.equal(terminal.status, 401);
  await waitFor(() => terminal.socket.destroyed);
  assert.equal((await handshake(t, f.gateway)).status, 404);
});

test('staged control input has a small cap while handshake is pending, independently of the session byte cap', async t => {
  const f = await fixture(t, { ws: () => {} }); await f.post();
  const req = http.request(`http://127.0.0.1:${f.gateway.port}/v1/live/rtc_fixture_1`, { headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13' }, agent: false });
  req.on('error', () => {}); const response = once(req, 'response'); req.end();
  await waitFor(() => f.wsCalls.length === 1); req.socket.write(Buffer.alloc(64 * 1024 + 1));
  const [res] = await response; assert.equal(res.statusCode, 413); assert.equal(JSON.parse(await buffer(res)).error.code, 'request_too_large');
  await waitFor(() => f.wsCalls[0].socket.destroyed); assert.equal((await f.control()).body.active_requests, 0);
});
