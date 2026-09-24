import { readdir, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ensureState, readPrivate, writePrivate, readAuth, noSymlinkParents } from './state.mjs';

export const accountError = (code, message) => Object.assign(new Error(message), { code, next_action: 'accounts' });
export function accountRoot(root, id) {
  if (id === 'default') return root;
  if (!/^[a-f0-9]{24}$/.test(id ?? '')) throw accountError('invalid_account', 'Select an existing account.');
  return join(root, 'accounts', id);
}
export async function getAccount(root, id) {
  const path = accountRoot(root, id);
  let metadata;
  try { metadata = await readPrivate(join(path, 'account.json')); }
  catch (e) { if (id === 'default' && e.code === 'ENOENT') return { id, label: 'Default', path }; throw e; }
  if (typeof metadata?.label !== 'string' || !metadata.label.trim() || metadata.label.length > 60) throw accountError('invalid_account', 'Account metadata is invalid.');
  return { id, label: metadata.label, path };
}
export async function selectedAccount(root) {
  let selection;
  try { selection = await readPrivate(join(root, 'selected-account.json')); }
  catch (e) { if (e.code === 'ENOENT') return getAccount(root, 'default'); throw e; }
  return getAccount(root, selection?.id);
}
export async function listAccounts(root) {
  const selected = await selectedAccount(root);
  const directory = join(root, 'accounts');
  await noSymlinkParents(directory);
  const entries = await readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const ids = ['default', ...entries.filter(id => /^[a-f0-9]{24}$/.test(id)).sort()];
  const accounts = [];
  for (const id of ids) {
    const account = await getAccount(root, id);
    let ready = true;
    try { await readAuth(account.path, { create: false }); } catch { ready = false; }
    accounts.push({ id, label: account.label, selected: id === selected.id, authenticated: ready });
  }
  return accounts;
}
export async function addAccount(root, label) {
  validateLabel(label);
  await ensureState(root);
  const id = randomBytes(12).toString('hex'), path = accountRoot(root, id);
  await ensureState(path);
  await writePrivate(join(path, 'account.json'), JSON.stringify({ label: label.trim() }));
  return { id, label: label.trim() };
}
function validateLabel(label) {
  if (typeof label !== 'string' || !label.trim() || label.trim().length > 60 || /[\x00-\x1f\x7f]/.test(label)) throw accountError('invalid_arguments', 'Account label must be 1–60 printable characters.');
}
export async function renameAccount(root, id, label) {
  validateLabel(label);
  const account = await getAccount(root, id);
  await ensureState(account.path);
  const target = join(account.path, 'account.json');
  const temporary = join(account.path, `account-${randomBytes(12).toString('hex')}.json`);
  await writePrivate(temporary, JSON.stringify({ label: label.trim() }));
  try { await rename(temporary, target); } finally { await unlink(temporary).catch(() => {}); }
  return { id, label: label.trim() };
}
export async function selectAccount(root, id) {
  const account = await getAccount(root, id);
  try { await readAuth(account.path, { create: false }); }
  catch { throw accountError('login_required', 'Sign in to this account first.'); }
  await ensureState(root);
  const target = join(root, 'selected-account.json');
  await noSymlinkParents(target);
  const existing = await lstat(target).catch(e => { if(e.code === 'ENOENT') return null; throw e; });
  if (existing) await readPrivate(target);
  const temporary = join(root, `selection-${randomBytes(12).toString('hex')}.json`);
  await writePrivate(temporary, JSON.stringify({ id }));
  try { await rename(temporary, target); } finally { await unlink(temporary).catch(() => {}); }
  return account;
}
