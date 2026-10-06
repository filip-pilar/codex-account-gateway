import { createHash } from 'node:crypto';
import { once } from 'node:events';

export const REALTIME_CALL_PATH = '/backend-api/codex/realtime/calls';
export const REALTIME_CALL_TARGET = 'https://chatgpt.com/backend-api/codex/realtime/calls';
export const REALTIME_HEADERS = ['openai-alpha', 'x-session-id', 'session-id', 'thread-id', 'originator', 'user-agent', 'x-codex-turn-metadata', 'x-oai-attestation', 'openai-safety-identifier', 'openai-organization', 'openai-project'];
const validId = id => /^(?:rtc_[A-Za-z0-9_-]{1,196}|[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12})$/.test(id);
const acceptKey = key => createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

// Location is used only to extract an opaque ID, never as a destination URL.
export function realtimeCallId(location) {
  return typeof location === 'string' && location.length <= 8192
    ? location.split('?')[0].split('/').findLast(validId) : undefined;
}

export function createRealtime({ upgradeTransport, active, isSelecting, maxBytes, timeoutMs, maxHeaderBytes, callTtlMs = 60 * 60 * 1000, maxCalls = 64 }) {
  if (!Number.isInteger(callTtlMs) || callTtlMs < 1 || callTtlMs > 2147483647 || !Number.isSafeInteger(maxCalls) || maxCalls < 1) throw new Error('invalid_realtime_limits');
  const calls = new Map();
  let pending = 0;
  const drop = call => {
    if (calls.get(call.id) !== call) return;
    calls.delete(call.id);
    clearTimeout(call.timer);
    call.abort?.();
    call.auth = null;
  };
  return {
    // Reserve capacity before authentication/upload so concurrent creations are bounded.
    reserve() {
      if (calls.size + pending >= maxCalls) return null;
      pending++;
      let released = false;
      const release = () => { if (!released) { released = true; pending--; } };
      return {
        release,
        commit(location, auth) {
          const id = realtimeCallId(location);
          if (!id || calls.has(id)) throw new Error('invalid_realtime_location');
          const call = { id, auth: { token: auth.token, account: auth.account }, abort: null };
          call.timer = setTimeout(() => drop(call), callTtlMs).unref();
          calls.set(id, call);
          release();
          return () => drop(call);
        },
      };
    },
    async upgrade(req, socket, head) {
      const queryAt = req.url.indexOf('?');
      const path = queryAt < 0 ? req.url : req.url.slice(0, queryAt);
      const id = path.startsWith('/v1/live/') ? path.slice('/v1/live/'.length) : '';
      if (!validId(id)) return false;
      socket.pause();
      let responseStarted = false;
      const reject = (status, code) => {
        if (socket.destroyed || socket.writableEnded) return;
        if (responseStarted) { socket.destroy(); return; }
        const body = JSON.stringify({ error: { type: 'codex_gateway_error', code, message: code } });
        socket.end(`HTTP/1.1 ${status} ${httpStatus(status)}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${body}`);
        socket.destroySoon();
      };
      socket.on('error', () => socket.destroy());
      if (isSelecting()) { reject(503, 'account_switch_in_progress'); return true; }
      const key = req.headers['sec-websocket-key'];
      if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16 || req.headers['openai-alpha'] !== 'quicksilver=v2') {
        reject(400, 'invalid_realtime_handshake'); return true;
      }
      // Codex v3 does not negotiate compression. Keeping it disabled makes the
      // wire-byte cap meaningful without decoding private control messages.
      if (req.headers['sec-websocket-extensions']) { reject(400, 'realtime_extensions_unsupported'); return true; }
      const call = calls.get(id);
      if (!call) { reject(404, 'realtime_call_not_found'); return true; }
      if (call.abort) { reject(409, 'realtime_call_busy'); return true; }
      const handshakeBytes = Math.min(maxBytes, 64 * 1024);
      if (head.length > handshakeBytes) { reject(413, 'request_too_large'); return true; }
      const controller = new AbortController();
      let upstream, upgraded = false, ended = false;
      const pendingFrames = head.length ? [head] : [];
      let pendingBytes = head.length, stage;
      const cleanup = () => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        controller.abort();
        if (stage) socket.removeListener('data', stage);
        pendingFrames.length = 0;
        upstream?.socket?.destroy();
        upstream?.body?.destroy?.();
        if (upgraded) socket.destroy();
        if (call.abort === abort) call.abort = null;
        active.delete(abort);
      };
      const abort = () => { socket.destroy(); cleanup(); };
      call.abort = abort;
      active.add(abort);
      const timer = setTimeout(() => {
        if (!upgraded) reject(504, 'upstream_timeout');
        else socket.destroy();
        cleanup();
      }, timeoutMs);
      const progress = () => { if (!ended) timer.refresh(); };
      socket.once('close', cleanup);
      socket.once('end', abort);
      // Consume early bytes while connecting so a FIN is observable even when
      // the upstream stalls. This staging buffer is capped at 64 KiB and is
      // discarded on rejection; established control traffic is never buffered.
      stage = chunk => {
        if (ended) return;
        pendingBytes += chunk.length;
        if (pendingBytes > handshakeBytes) { reject(413, 'request_too_large'); cleanup(); }
        else { pendingFrames.push(chunk); progress(); }
      };
      socket.on('data', stage); socket.resume();
      try {
        const headers = new Headers();
        for (const name of REALTIME_HEADERS) if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
        headers.set('authorization', `Bearer ${call.auth.token}`);
        headers.set('chatgpt-account-id', call.auth.account);
        headers.set('connection', 'Upgrade'); headers.set('upgrade', 'websocket');
        headers.set('sec-websocket-key', key); headers.set('sec-websocket-version', '13');
        if (req.headers['sec-websocket-protocol']) headers.set('sec-websocket-protocol', req.headers['sec-websocket-protocol']);
        headers.set('accept-encoding', 'identity');
        upstream = await upgradeTransport(`wss://api.openai.com${path}${queryAt < 0 ? '' : req.url.slice(queryAt)}`, { headers, signal: controller.signal, maxHeaderSize: maxHeaderBytes });
        socket.pause(); socket.removeListener('data', stage);
        controller.signal.throwIfAborted();
        progress();
        if (upstream.status !== 101) {
          const forwarded = ['content-type', 'content-encoding', 'content-length', 'retry-after', 'retry-after-ms', 'x-request-id'];
          let response = `HTTP/1.1 ${upstream.status} ${httpStatus(upstream.status)}\r\nCache-Control: no-store\r\nConnection: close\r\n`;
          for (const name of forwarded) if (upstream.headers.has(name)) response += `${name}: ${upstream.headers.get(name)}\r\n`;
          responseStarted = true;
          socket.write(response + '\r\n');
          if (upstream.body) for await (const chunk of upstream.body) {
            progress();
            if (!socket.write(chunk)) await once(socket, 'drain', { signal: controller.signal });
          }
          socket.end(); socket.destroySoon();
          cleanup();
          if ([401, 403, 404, 410].includes(upstream.status)) drop(call);
          return true;
        }
        const protocol = upstream.headers.get('sec-websocket-protocol');
        const offered = req.headers['sec-websocket-protocol']?.split(',').map(value => value.trim()) ?? [];
        if (!upstream.socket || upstream.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !upstream.headers.get('connection')?.toLowerCase().split(',').map(value => value.trim()).includes('upgrade') || upstream.headers.get('sec-websocket-accept') !== acceptKey(key) || upstream.headers.has('sec-websocket-extensions') || (protocol && !offered.includes(protocol))) throw new Error('invalid_upstream_handshake');
        let response = `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nCache-Control: no-store\r\n`;
        if (protocol) response += `Sec-WebSocket-Protocol: ${protocol}\r\n`;
        responseStarted = true;
        socket.write(response + '\r\n');
        upgraded = true;
        let sent = pendingBytes;
        socket.on('data', chunk => {
          sent += chunk.length;
          if (sent > maxBytes) abort();
          else progress();
        });
        upstream.socket.on('data', progress);
        upstream.socket.once('error', abort);
        upstream.socket.once('close', () => { if (!upstream.socket.readableEnded) abort(); });
        upstream.socket.once('end', () => { socket.end(); socket.destroySoon(); });
        // Relay untouched frames (including fragments, ping/pong and close),
        // preserving masking, ordering and backpressure. Never replay messages.
        if (upstream.head?.length) socket.write(upstream.head);
        for (const chunk of pendingFrames) upstream.socket.write(chunk);
        pendingFrames.length = 0;
        socket.pipe(upstream.socket); upstream.socket.pipe(socket);
        socket.resume(); upstream.socket.resume();
      } catch {
        if (!upgraded) reject(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'upstream_timeout' : 'upstream_unavailable');
        cleanup();
        if ([401, 403, 404, 410].includes(upstream?.status)) drop(call);
        // A canceled handshake may resolve with a socket after its abort listener ran.
        upstream?.socket?.destroy(); upstream?.body?.destroy?.();
      }
      socket.removeListener('data', stage);
      return true;
    },
    close() { for (const call of calls.values()) drop(call); },
  };
}

const httpStatus = status => ({ 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large', 429: 'Too Many Requests', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' }[status] ?? 'Upstream Response');
