import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { join } from 'node:path';
import { readAuth } from './state.mjs';
import { accountError } from './accounts.mjs';

function window(value) {
  if (!value || !Number.isFinite(value.usedPercent)) return null;
  return {
    remaining_percent: Math.max(0, Math.min(100, 100 - value.usedPercent)),
    window_minutes: Number.isFinite(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null,
    resets_at: Number.isFinite(value.resetsAt) && value.resetsAt > 0 ? value.resetsAt : null,
  };
}
export function normalizeUsage(result) {
  const buckets = result?.rateLimitsByLimitId;
  const source = buckets && Object.keys(buckets).length ? Object.entries(buckets) : [['codex', result?.rateLimits]];
  return source.filter(([, value]) => value && typeof value === 'object').slice(0, 32).map(([id, value]) => ({
    id: String(id).slice(0, 100),
    primary: window(value.primary), secondary: window(value.secondary),
  }));
}
// Ask the official CLI for limits only. Never start a thread or request inference.
// Credentials, RPC errors and unrelated notifications never leave this function.
export async function readUsage(root, { executable = 'codex', timeoutMs = 15000, signal } = {}) {
  try { await readAuth(root, { create: false }); }
  catch { throw Object.assign(accountError('login_required', 'Sign in to this account first.'), { category: 'login_required' }); }
  if (signal?.aborted) throw Object.assign(accountError('usage_unavailable', 'Usage check cancelled.'), { category: 'cancelled' });
  const env = { ...process.env, CODEX_HOME: join(root, 'codex') };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-c', 'cli_auth_credentials_store="file"', 'app-server', '--listen', 'stdio://'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '', bytes = 0, settled = false, initialized = false;
    const decoder = new StringDecoder('utf8');
    const finish = (code, value, category) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.stdin.destroy(); child.stdout.destroy(); child.kill('SIGKILL');
      if (code) reject(Object.assign(accountError(code, code === 'usage_timeout' ? 'Usage check timed out.' : 'Usage is unavailable. Try refreshing later.'), { category }));
      else resolve({ checked_at: new Date().toISOString(), buckets: normalizeUsage(value) });
    };
    const timer = setTimeout(() => finish('usage_timeout', null, 'timeout'), timeoutMs);
    const abort = () => finish('usage_unavailable', null, 'cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.once('error', () => finish('cli_unavailable', null, 'cli_unavailable'));
    child.once('exit', () => finish('usage_unavailable', null, 'child_exit'));
    child.stdin.on('error', () => finish('usage_unavailable', null, 'pipe_error'));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) return finish('usage_unavailable', null, 'output_limit');
      buffer += decoder.write(chunk);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { return finish('usage_unavailable', null, 'invalid_response'); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return finish('usage_unavailable', null, 'invalid_response');
        if (message.id === 1 && !initialized) {
          if (message.error || !message.result) return finish('usage_unavailable', null, message.error ? 'rpc_error' : 'invalid_response');
          initialized = true;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (message.id === 2 && initialized) {
          return finish(message.error || !message.result ? 'usage_unavailable' : null, message.result,
            message.error ? 'rpc_error' : 'invalid_response');
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'codex_gateway_usage', title: 'Codex Gateway', version: '0.1.0' }, capabilities: null } });
  });
}
