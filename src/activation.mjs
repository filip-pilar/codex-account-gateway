import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { ensureState, readPrivate, writePrivate, readAuth } from './state.mjs';
import { readActivationModel } from './usage.mjs';
import { requestUpstream } from './transport.mjs';

const WEEK_SECONDS = 604800;
const states = new Set(['pending', 'verifying', 'confirmed', 'failed', 'unconfirmed']);
const errors = new Set(['login_required', 'upstream_rejected', 'output_limit', 'incomplete_response', 'cancelled', 'timeout', 'activation_failed', 'verification_failed']);
const failure = category => Object.assign(new Error('Weekly activation did not complete.'), { category });

async function replacePrivate(root, name, value) {
  await ensureState(root);
  const target = join(root, name), temporary = join(root, `${name}.${randomBytes(12).toString('hex')}`);
  await writePrivate(temporary, JSON.stringify(value));
  try { await rename(temporary, target); } finally { await unlink(temporary).catch(() => {}); }
}
export async function readWeeklyActivation(root) {
  try {
    const value = await readPrivate(join(root, 'weekly-activation.json'));
    if (typeof value.enabled !== 'boolean') throw failure('invalid_activation_setting');
    return value.enabled;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export async function writeWeeklyActivation(root, enabled) {
  if (typeof enabled !== 'boolean') throw failure('invalid_activation_setting');
  await readWeeklyActivation(root);
  await replacePrivate(root, 'weekly-activation.json', { enabled });
}
export async function readActivationAttempt(root) {
  try {
    const value = await readPrivate(join(root, 'weekly-activation-attempt.json'));
    if (!states.has(value.state) || !Number.isSafeInteger(value.attempted_at) || Math.abs(value.attempted_at) > 8.64e15 ||
        value.confirmed_reset_at != null && (!Number.isFinite(value.confirmed_reset_at) || Math.abs(value.confirmed_reset_at) > 8.64e12) ||
        value.last_error != null && !errors.has(value.last_error)) throw failure('invalid_activation_attempt');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeActivationAttempt(root, attempt) {
  await readActivationAttempt(root);
  await replacePrivate(root, 'weekly-activation-attempt.json', attempt);
}

// A full percentage is insufficient. Require two well-separated reports whose
// reset advances with the clock and remains approximately seven days ahead.
export function observeWeeklyWindow(previous, window, at) {
  const observation = window ? { at, reset: window.resets_at, remaining: window.remaining_percent } : null;
  if (!window || !Number.isFinite(window.resets_at) || window.resets_at * 1000 <= at) return { state: 'unknown', observation };
  if (window.remaining_percent < 100) return { state: 'fixed', observation };
  const elapsed = previous ? (at - previous.at) / 1000 : 0;
  if (elapsed < 30 || elapsed > 300 || previous?.remaining !== 100 || !Number.isFinite(previous.reset))
    return { state: 'unknown', observation };
  const shift = window.resets_at - previous.reset;
  if (Math.abs(shift) <= 2) return { state: 'fixed', observation };
  if (Math.abs(window.resets_at - at / 1000 - WEEK_SECONDS) <= 10 &&
      Math.abs(previous.reset - previous.at / 1000 - WEEK_SECONDS) <= 10 && Math.abs(shift - elapsed) <= 10)
    return { state: 'appears_unstarted', observation };
  return { state: 'unknown', observation };
}

// This is the sole inference path for activation. Discover through the official
// isolated CLI (which owns renewal), then issue one tool-free, non-stored request.
// Do not retry, follow redirects, persist output, or change account selection.
export async function activateWeeklyWindow(root, { signal, modelReader = readActivationModel, transport = requestUpstream, timeoutMs = 30000 } = {}) {
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) cancellation.abort();
  const timer = setTimeout(abort, timeoutMs);
  try {
    const { model, effort } = await modelReader(root, { signal: cancellation.signal });
    cancellation.signal.throwIfAborted();
    const auth = await readAuth(root, { create: false });
    const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${auth.token}`,
      'chatgpt-account-id': auth.account, originator: 'codex_cli_rs' });
    const body = Readable.from([JSON.stringify({ model, stream: true, store: false, tools: [], tool_choice: 'none',
      instructions: 'Reply only with OK.', ...(effort ? { reasoning: { effort } } : {}),
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with OK.' }] }] })]);
    const response = await transport('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST', headers, body, signal: cancellation.signal, maxHeaderSize: 65536,
    });
    if (response.status !== 200) { response.body?.destroy(); throw failure(response.status === 401 ? 'login_required' : 'upstream_rejected'); }
    let bytes = 0, pending = '', completed = false;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      cancellation.signal.throwIfAborted();
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw failure('output_limit');
      pending += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).trimEnd(); pending = pending.slice(end + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim(); if (payload === '[DONE]') continue;
        const event = JSON.parse(payload);
        if (event.type === 'response.completed' && event.response?.status === 'completed') completed = true;
        if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw failure('incomplete_response');
      }
    }
    if (!completed) throw failure('incomplete_response');
  } catch (error) {
    throw failure(cancellation.signal.aborted ? (signal?.aborted ? 'cancelled' : 'timeout') :
      ['login_required', 'upstream_rejected', 'output_limit', 'incomplete_response'].includes(error.category) ? error.category : 'activation_failed');
  } finally {
    clearTimeout(timer); cancellation.abort(); signal?.removeEventListener('abort', abort);
  }
}
