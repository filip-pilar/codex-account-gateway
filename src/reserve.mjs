import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureState, readPrivate, writePrivate } from './state.mjs';

export async function readReserveUsage(root) {
  try {
    const value = await readPrivate(join(root, 'reserve-usage.json'));
    if (typeof value?.allow_reserve_usage !== 'boolean') throw new Error('Invalid reserve usage setting.');
    return value.allow_reserve_usage;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function writeReserveUsage(root, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Reserve usage must be boolean.');
  await ensureState(root);
  await readReserveUsage(root); // Refuse unsafe existing state.
  const target = join(root, 'reserve-usage.json');
  const temporary = join(root, `reserve-${randomBytes(12).toString('hex')}.json`);
  await writePrivate(temporary, JSON.stringify({ allow_reserve_usage: enabled }));
  try { await rename(temporary, target); } finally { await unlink(temporary).catch(() => {}); }
}
