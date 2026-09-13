import { mkdir, lstat, open, link, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, dirname } from 'node:path';

export const stateRoot = () => resolve(process.env.CODEX_GATEWAY_HOME || join(homedir(), '.local/share/codex-gateway'));
export async function noSymlinkParents(path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    const s = await lstat(p).catch(e => { if(e.code !== 'ENOENT') throw e; return null; });
    if (s?.isSymbolicLink()) throw new Error('Symbolic links are not allowed in private state paths.');
    if (p === dirname(p)) break;
  }
}
export async function ensureState(root) {
  await noSymlinkParents(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const s = await lstat(root);
  if (!s.isDirectory() || (s.mode & 0o077)) throw new Error('State directory must be private (mode 700).');
  const home = join(root, 'codex');
  await mkdir(home, { mode: 0o700 }).catch(e => { if(e.code !== 'EEXIST') throw e; });
  const h = await lstat(home);
  if (!h.isDirectory() || h.isSymbolicLink() || (h.mode & 0o077)) throw new Error('Unsafe Codex state directory.');
  return home;
}
export async function readPrivate(path) {
  await noSymlinkParents(path);
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await f.stat();
    if (!s.isFile() || (s.mode & 0o077) || s.size > 65536) throw new Error('Unsafe private state file.');
    return JSON.parse(await f.readFile('utf8'));
  } finally { await f.close(); }
}
export async function writePrivate(path, value) {
  await noSymlinkParents(path);
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  const f = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await f.writeFile(value);
    await f.close();
    await link(temporary, path); // Publish complete contents exclusively; never overwrite.
  } finally { await f.close(); await unlink(temporary).catch(() => {}); }
}
export async function readAuth(root, { create = true } = {}) {
  const home = create ? await ensureState(root) : join(root, 'codex');
  for (const path of [root, home]) {
    await noSymlinkParents(path);
    const s = await lstat(path);
    if (!s.isDirectory() || (s.mode & 0o077)) throw new Error('Unsafe private state directory.');
  }
  const a = await readPrivate(join(home, 'auth.json'));
  if (a.auth_mode !== 'chatgpt' || !a.tokens?.access_token || !a.tokens?.account_id) throw new Error('Run codex-gateway login with a ChatGPT account.');
  return { token: a.tokens.access_token, account: a.tokens.account_id };
}
