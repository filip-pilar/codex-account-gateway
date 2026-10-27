import { readRoutingPolicy, updateRoutingPolicy, allowsReserve, reserveFallback } from './routing-policy.mjs';

export async function readReserveUsage(root) {
  return allowsReserve((await readRoutingPolicy(root)).fallback);
}

export async function writeReserveUsage(root, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Reserve usage must be boolean.');
  const policy = await readRoutingPolicy(root);
  await updateRoutingPolicy(root, { fallback: reserveFallback(policy.fallback, enabled) });
}
