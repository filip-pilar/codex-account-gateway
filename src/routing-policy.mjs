import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureState, readPrivate, writePrivate } from './state.mjs';
import { listAccounts, accountError } from './accounts.mjs';

export const FALLBACKS = ['pause', 'reserve', 'credits', 'reserve_then_credits', 'credits_then_reserve'];
export const allowsReserve = fallback => ['reserve', 'reserve_then_credits', 'credits_then_reserve'].includes(fallback);
export const allowsCredits = fallback => ['credits', 'reserve_then_credits', 'credits_then_reserve'].includes(fallback);
export const reserveFallback = (fallback, enabled) => enabled
  ? allowsCredits(fallback) ? fallback === 'credits_then_reserve' ? fallback : 'reserve_then_credits' : 'reserve'
  : allowsCredits(fallback) ? 'credits' : 'pause';
export const defaultPolicy = reserve => ({ mode: 'automatic', fixed_account: null, account_order: [], fallback: reserve ? 'reserve_then_credits' : 'credits' });
const validID = id => typeof id === 'string' && /^(default|[a-f0-9]{24})$/.test(id);

function validate(policy) {
  if (!policy || !['automatic', 'fixed'].includes(policy.mode) || !FALLBACKS.includes(policy.fallback) ||
      policy.fixed_account !== null && !validID(policy.fixed_account) ||
      policy.mode === 'fixed' && !validID(policy.fixed_account) || !Array.isArray(policy.account_order) ||
      !policy.account_order.every(validID) || new Set(policy.account_order).size !== policy.account_order.length)
    throw accountError('invalid_routing_policy', 'Routing settings are invalid.');
  return policy;
}

// Extend the existing reserve file atomically so installed profiles and the
// reserve-usage command retain a single source of truth.
export async function readRoutingPolicy(root) {
  let saved;
  try { saved = await readPrivate(join(root, 'reserve-usage.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (saved !== undefined && (typeof saved?.allow_reserve_usage !== 'boolean' ||
      Object.keys(saved).some(key => !['allow_reserve_usage', 'mode', 'fixed_account', 'account_order', 'fallback'].includes(key))))
    throw accountError('invalid_routing_policy', 'Reserve setting is invalid.');
  const policy = validate({ ...defaultPolicy(saved?.allow_reserve_usage === true),
    ...(saved?.mode !== undefined ? { mode: saved.mode } : {}),
    ...(saved?.fixed_account !== undefined ? { fixed_account: saved.fixed_account } : {}),
    ...(saved?.account_order !== undefined ? { account_order: saved.account_order } : {}),
    ...(saved?.fallback !== undefined ? { fallback: saved.fallback } : {}) });
  if (saved && allowsReserve(policy.fallback) !== saved.allow_reserve_usage)
    throw accountError('invalid_routing_policy', 'Routing and reserve settings disagree.');
  return policy;
}

export function orderedAccounts(accounts, policy) {
  const known = new Map(accounts.map(item => [item.id, item]));
  return [...policy.account_order.map(id => known.get(id)).filter(Boolean),
    ...accounts.filter(item => !policy.account_order.includes(item.id))];
}

export async function updateRoutingPolicy(root, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) ||
      Object.keys(changes).some(key => !['mode', 'fixed_account', 'account_order', 'fallback'].includes(key)))
    throw accountError('invalid_arguments', 'Unknown routing setting.');
  const previous = await readRoutingPolicy(root);
  const accounts = await listAccounts(root);
  const policy = validate({ ...previous, ...changes });
  if (policy.fixed_account !== null && !accounts.some(item => item.id === policy.fixed_account) ||
      policy.account_order.some(id => !accounts.some(item => item.id === id)))
    throw accountError('invalid_account', 'Select an existing account.');
  if (!policy.account_order.length) {
    const start = Math.max(0, accounts.findIndex(item => item.selected));
    policy.account_order = [...accounts.slice(start), ...accounts.slice(0, start)].map(item => item.id);
  } else policy.account_order = orderedAccounts(accounts, policy).map(item => item.id);
  await ensureState(root);
  const temporary = join(root, `routing-${randomBytes(12).toString('hex')}.json`);
  await writePrivate(temporary, JSON.stringify({ ...policy, allow_reserve_usage: allowsReserve(policy.fallback) }));
  try { await rename(temporary, join(root, 'reserve-usage.json')); }
  finally { await unlink(temporary).catch(() => {}); }
  return policy;
}
