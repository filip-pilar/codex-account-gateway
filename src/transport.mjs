import http from 'node:http';
import https from 'node:https';
import { once } from 'node:events';

// Native HTTP keeps compressed bytes intact and leaves timeouts to the gateway's
// idle timer. fetch adds an independent headers deadline and decodes responses.
// Never follow redirects or retry a request containing backing credentials.
export function requestUpstream(url, { method, headers, body, signal, maxHeaderSize }) {
  return new Promise((resolve, reject) => {
    const client = new URL(url).protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method, headers: Object.fromEntries(headers), signal, maxHeaderSize,
    }, response => {
      const received = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) received.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      resolve({ status: response.statusCode, headers: received, body: response });
    });
    request.on('error', reject);
    void (async () => {
      for await (const chunk of body) {
        signal.throwIfAborted();
        if (!request.write(chunk)) await once(request, 'drain', { signal });
      }
      request.end();
    })().catch(error => request.destroy(error));
  });
}

// The gateway owns cancellation after upgrade; no WebSocket framing library is
// needed for an unchanged control tunnel. Non-101 responses remain HTTP streams.
export function upgradeUpstream(url, { headers, signal, maxHeaderSize }) {
  const target = new URL(url);
  target.protocol = target.protocol === 'wss:' ? 'https:' : target.protocol === 'ws:' ? 'http:' : target.protocol;
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(target, { method: 'GET', headers: Object.fromEntries(headers), signal, maxHeaderSize });
    const receivedHeaders = response => {
      const received = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) received.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      return received;
    };
    request.once('response', response => resolve({ status: response.statusCode, headers: receivedHeaders(response), body: response }));
    request.once('upgrade', (response, socket, head) => {
      socket.pause();
      socket.on('error', () => socket.destroy());
      if (signal.aborted) { socket.destroy(); reject(signal.reason); return; }
      resolve({ status: response.statusCode, headers: receivedHeaders(response), socket, head });
    });
    request.once('error', reject);
    request.end();
  });
}
