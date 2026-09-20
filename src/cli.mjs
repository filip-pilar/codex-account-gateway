#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, rmdir, unlink, lstat } from 'node:fs/promises';
import { join, resolve, isAbsolute, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import { stateRoot, ensureState, writePrivate, readPrivate, noSymlinkParents } from './state.mjs';
import { startServer } from './server.mjs';
import { selectedAccount, getAccount, listAccounts, addAccount, selectAccount } from './accounts.mjs';
import { readUsage } from './usage.mjs';
import { createRouter } from './routing.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const json = args.includes('--json');
const root = stateRoot(), runtime = join(root, 'runtime.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const error = (code, message, next_action = null) => Object.assign(new Error(message), { code, next_action });
function output(value) {
  const result = { schema_version: 1, command, ...value };
  if (process.connected) process.send(result, () => {});
  console.log(json ? JSON.stringify(result) : (value.message ?? JSON.stringify(result, null, 2)));
}
function options() {
  const allowed = {
    help: [], '--help': [], '-h': [], login: ['--account'],
    accounts: [], 'account-add': ['--label'], 'account-select': ['--account'], usage: ['--account'],
    start: ['--port', '--background'], stop: [], status: [], doctor: ['--port'],
    setup: ['--port', '--model', '--client-dir'],
  }[command];
  if (!Array.isArray(allowed)) throw error('invalid_arguments', 'Unknown command. Run --help.');
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key !== '--json' && !allowed.includes(key) || key in opts) throw error('invalid_arguments', 'Unknown or duplicate option. Run --help.');
    if (['--json', '--background'].includes(key)) opts[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw error('invalid_arguments', `Missing value for ${key}.`);
      opts[key] = args[++i];
    }
  }
  if (command === 'login' && json) throw error('invalid_arguments', 'login is interactive and does not support --json.');
  if (opts['--port'] && (!/^\d+$/.test(opts['--port']) || +opts['--port'] < 1024 || +opts['--port'] > 65535)) throw error('invalid_arguments', 'Port must be 1024–65535.');
  return opts;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
async function saved() {
  let r;
  try { r = await readPrivate(runtime); } catch (e) { if (e.code === 'ENOENT') return null; throw error('unsafe_runtime', 'Runtime state is unreadable or unsafe.', 'inspect_private_state'); }
  if (!r || typeof r !== 'object' || !Number.isInteger(r.pid) || r.pid < 1 || !Number.isInteger(r.port) || r.port < 1024 || r.port > 65535 || !/^[a-f0-9]{64}$/.test(r.controlToken ?? '') || !/^[a-f0-9]{32}$/.test(r.instanceId ?? '')) throw error('unsafe_runtime', 'Runtime state is invalid or from an older version.', 'inspect_private_state');
  return r;
}
function probe(r, action = 'status') {
  // A fresh built-in HTTP connection avoids the observed Undici shutdown crash.
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); req.destroy(); };
    const req = http.request({ hostname: '127.0.0.1', port: r.port, path: `/control/${action}`,
      method: action === 'stop' ? 'POST' : 'GET', agent: false,
      headers: { authorization: `Bearer ${r.controlToken}` },
    }, res => {
      let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 1024) finish(false); else chunks.push(chunk); });
      res.on('error', () => finish(false));
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          finish(res.statusCode === 200 && value?.instanceId === r.instanceId ? value : false);
        }
        catch { finish(false); }
      });
      res.on('close', () => finish(false));
    });
    const timer = setTimeout(() => finish(false), 1500);
    req.on('error', () => finish(false));
    req.end();
  });
}

async function selectRunning(r, id) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); req.destroy();
      if (value?.instanceId === r.instanceId && value.code === 'account_selected') resolve();
      else reject(error(value?.code === 'gateway_busy' ? 'gateway_busy' : value?.code === 'login_required' ? 'login_required' : 'account_switch_failed',
        value?.code === 'gateway_busy' ? 'Wait for active requests to finish, then switch accounts.' : 'Account switch failed.', 'status'));
    };
    const req = http.request({ hostname: '127.0.0.1', port: r.port, path: `/control/account/${id}`, method: 'POST', agent: false,
      headers: { authorization: `Bearer ${r.controlToken}` } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; if (body.length > 2048) finish(null); });
      res.on('error', () => finish(null));
      res.on('end', () => { try { finish(JSON.parse(body)); } catch { finish(null); } });
      res.on('close', () => finish(null));
    });
    const timer = setTimeout(() => finish(null), 5000);
    req.on('error', () => finish(null)); req.end();
  });
}

async function lockState() {
  try { await noSymlinkParents(root); await lstat(join(root, 'lifecycle.lock')); return 'present'; }
  catch (e) { return e.code === 'ENOENT' ? 'absent' : 'unsafe'; }
}
async function inspect() {
  const r = await saved();
  if (!r) return { state: 'stopped' };
  const control = await probe(r);
  if (control) return { state: 'running', port: r.port, pid: r.pid, url: `http://127.0.0.1:${r.port}/v1`, ...(control.routing ? { routing: control.routing } : {}) };
  return { state: alive(r.pid) ? 'unavailable' : 'stale', port: r.port, pid: r.pid };
}
// Serialize short runtime mutations. An interrupted mutation fails closed rather than
// guessing whether another process owns a partially recovered profile.
async function locked(fn) {
  const lock = join(root, 'lifecycle.lock');
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (attempt === 30) throw error('lifecycle_busy', 'Lifecycle mutation is busy or was interrupted.', 'inspect_private_state'); await sleep(100); }
  }
  try { return await fn(); } finally { await rmdir(lock); }
}
async function clearOwned(id) {
  await locked(async () => { if ((await saved())?.instanceId === id) await unlink(runtime); });
}
async function portAvailable(port) {
  const s = net.createServer();
  return new Promise(resolve => {
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function cliVersion() {
  return new Promise(resolve => {
    const p = spawn('codex', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '', settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => {
      p.kill('SIGKILL'); p.stdout.destroy(); p.unref(); finish(null);
    }, 3000);
    p.stdout.on('data', b => { if (out.length < 1024) out += b.toString().slice(0, 1024 - out.length); });
    p.once('error', () => finish(null));
    p.once('exit', code => finish(code === 0 ? out.match(/\bcodex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)?.[1] ?? null : null));
  });
}
function config(model, port) {
  return `model = ${JSON.stringify(model)}
model_provider = "codex-gateway"
model_reasoning_effort = "low"
check_for_update_on_startup = false

[model_providers.codex-gateway]
name = "OpenAI"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
supports_standalone_web_search = true
http_headers = { "x-openai-actor-authorization" = "codex-gateway" }
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 240000
`;
}
const inside = (a, b) => { const r = relative(a, b); return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };
async function setup(opts, port) {
  const model = opts['--model'];
  if (!model || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(model)) throw error('invalid_arguments', 'setup requires --model with an explicit model identifier.');
  const toml = config(model, port), target = opts['--client-dir'];
  if (!target) return output({ ok: true, code: 'configuration', config: toml, message: toml });
  if (!isAbsolute(target)) throw error('invalid_arguments', '--client-dir must be absolute.');
  const dir = resolve(target), repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const primary = resolve(process.env.CODEX_HOME || join(process.env.HOME || '', '.codex'));
  if ([root, primary, repo].some(p => inside(p, dir) || inside(dir, p))) throw error('unsafe_client_directory', 'Client directory must be separate from gateway state, the repository, and the current client profile.');
  try { await noSymlinkParents(dir); } catch { throw error('unsafe_client_directory', 'Client directory must not use symlink paths.'); }
  try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') throw error('client_directory_exists', 'Client directory must be new; existing configuration is never overwritten.', 'choose_new_client_directory'); throw e; }
  try { await writePrivate(join(dir, 'config.toml'), toml); }
  catch (e) { await rmdir(dir).catch(() => {}); throw e; }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launch = `env -u OPENAI_API_KEY -u CODEX_API_KEY -u OPENAI_BASE_URL CODEX_HOME=${quote(dir)} codex`;
  output({ ok: true, code: 'configuration_created', client_dir: dir, config_path: join(dir, 'config.toml'), launch: { executable: 'codex', args: [], env: { CODEX_HOME: dir }, unset_env: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL'] }, launch_command: launch });
}
async function background(opts) {
  const argv = [fileURLToPath(import.meta.url), 'start', '--json'];
  if (opts['--port']) argv.push('--port', opts['--port']);
  const p = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { p.kill('SIGTERM'); reject(error('start_timeout', 'Background startup timed out.', 'status')); }, 10000);
    p.once('message', result => { clearTimeout(timer); resolve(result); });
    p.once('error', () => { clearTimeout(timer); reject(error('start_failed', 'Could not launch background process.')); });
    p.once('exit', () => { clearTimeout(timer); reject(error('start_failed', 'Background process exited before readiness.', 'doctor')); });
  });
  if (p.connected) p.disconnect();
  p.unref();
  if (!result.ok) { process.exitCode = 1; output(result); return; }
  output({ ...result, background: true });
}
async function start(opts, port) {
  if (opts['--background']) return background(opts);
  await ensureState(root);
  const result = await locked(async () => {
    const old = await saved();
    if (old) {
      if (await probe(old)) {
        if (opts['--port'] && port !== old.port) throw error('already_running_other_port', 'Profile is running on another port.', 'stop');
        return { existing: old };
      }
      if (alive(old.pid)) throw error('runtime_unavailable', 'Recorded process still exists but cannot be verified.', 'status');
      await unlink(runtime);
    }
    if (!(await listAccounts(root)).some(account => account.authenticated)) throw error('login_required', 'Isolated credentials are missing or unsafe.', 'login');
    const r = { pid: process.pid, port, instanceId: randomBytes(16).toString('hex'), controlToken: randomBytes(32).toString('hex') };
    let server, stopping;
    const router = createRouter({ root, select: id => locked(() => selectAccount(root, id)) });
    const stop = () => stopping ??= (async () => {
      await Promise.all([router.close(), server.close()]);
      await clearOwned(r.instanceId);
    })().catch(() => { process.exitCode = 1; });
    server = await startServer({ port, credentials: router.credentials, onSelect: router.select,
      routingStatus: router.status, controlToken: r.controlToken, instanceId: r.instanceId, onStop: stop });
    try { await writePrivate(runtime, JSON.stringify(r)); } catch (e) { await server.close(); await router.close(); throw e; }
    void router.refresh();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    return { current: r };
  });
  const r = result.existing ?? result.current;
  output({ ok: true, code: result.existing ? 'already_running' : 'started', state: 'running', pid: r.pid, port: r.port, url: `http://127.0.0.1:${r.port}/v1`, message: `codex-gateway listening at http://127.0.0.1:${r.port}/v1` });
}
async function main() {
  const opts = options(), port = Number(opts['--port'] ?? 8787);
  if (['help', '--help', '-h'].includes(command)) return output({ ok: true, code: 'help', message: `codex-gateway 0.1.0
login [--account ID]                       Interactive official CLI login
accounts                                   List isolated account profiles
account-add --label NAME                    Add an unsigned-in account
account-select --account ID                 Select account when gateway is idle
usage [--account ID]                        Read reported limits via official CLI
start [--port NUMBER] [--background]        Start or report existing instance
status                                     Verify selected instance
stop                                       Stop selected instance (idempotent)
doctor [--port NUMBER]                      Local checks only
setup --model MODEL [--port NUMBER] [--client-dir NEW_ABSOLUTE_DIRECTORY]
All commands except login accept --json. See docs/cli.md.
CODEX_GATEWAY_HOME selects private state. No global configuration edits.` });
  if (command === 'setup') return setup(opts, port);
  if (command === 'accounts') return output({ ok: true, code: 'accounts', accounts: await listAccounts(root) });
  if (command === 'account-add') return output({ ok: true, code: 'account_added', account: await addAccount(root, opts['--label']) });
  if (command === 'usage') {
    const account = opts['--account'] ? await getAccount(root, opts['--account']) : await selectedAccount(root);
    return output({ ok: true, code: 'usage', account: account.id, ...await readUsage(account.path) });
  }
  if (command === 'account-select') {
    if (!opts['--account']) throw error('invalid_arguments', 'account-select requires --account.');
    await getAccount(root, opts['--account']);
    await ensureState(root);
    // Probe/select under the lifecycle lock when stopped. The running server owns
    // selection and refuses changes while any request is in flight.
    const running = await locked(async () => {
      const r = await saved();
      if (r && await probe(r)) return r;
      if (r && alive(r.pid)) throw error('runtime_unavailable', 'Runtime cannot be verified.', 'status');
      await selectAccount(root, opts['--account']);
      return null;
    });
    if (running) await selectRunning(running, opts['--account']);
    return output({ ok: true, code: 'account_selected', account: opts['--account'] });
  }
  if (command === 'login') {
    const account = opts['--account'] ? await getAccount(root, opts['--account']) : await selectedAccount(root);
    const home = await ensureState(account.path);
    await writePrivate(join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n').catch(e => { if (e.code !== 'EEXIST') throw e; });
    const env = { ...process.env, CODEX_HOME: home };
    for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[key];
    const p = spawn('codex', ['-c', 'cli_auth_credentials_store="file"', 'login'], { env, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { p.once('error', () => reject(error('cli_unavailable', 'Official Codex CLI is unavailable.', 'install_official_cli'))); p.once('exit', code => resolve(code ?? 1)); });
    if (code) throw error('login_failed', 'Official CLI login did not complete.', 'login');
    return output({ ok: true, code: 'login_completed' });
  }
  if (command === 'doctor') {
    const version = await cliVersion();
    let credentials = 'missing_or_unsafe';
    try { if ((await listAccounts(root)).some(account => account.authenticated)) credentials = 'present'; } catch {}
    let status; try { status = await inspect(); } catch (e) { status = { state: 'unsafe', code: e.code }; }
    const lifecycle_lock = await lockState();
    const selectedPort = opts['--port'] ? port : status.port ?? port;
    const available = await portAvailable(selectedPort);
    const node = process.versions.node;
    const supported = Number(node.split('.')[0]) > 22 || Number(node.split('.')[0]) === 22 && Number(node.split('.')[1]) >= 15;
    const ok = lifecycle_lock === 'absent' && supported && !!version && credentials === 'present' && ['running', 'stopped', 'stale'].includes(status.state) && (available || status.state === 'running' && status.port === selectedPort);
    output({ ok, code: ok ? 'local_ready' : 'local_not_ready', profile: root, node: { version: node, supported }, cli: { version, historical_baseline: '0.149.1', matches_baseline: version === '0.149.1' }, credentials, runtime: status, lifecycle_lock, port: { number: selectedPort, available }, upstream: 'not_checked', next_action: lifecycle_lock !== 'absent' ? 'inspect_private_state' : !version ? 'install_official_cli' : credentials !== 'present' ? 'login' : !ok ? 'inspect_local_checks' : status.state !== 'running' ? 'start' : null });
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === 'status') {
    const status = await inspect();
    const ok = status.state === 'running';
    output({ ok, code: status.state, ...status, profile: root, upstream: 'not_checked', next_action: ok ? null : status.state === 'stopped' || status.state === 'stale' ? 'start' : 'inspect_private_state' });
    if (!ok) process.exitCode = 1;
    return;
  }
  if (command === 'stop') {
    const r = await saved();
    if (!r) return output({ ok: true, code: 'already_stopped' });
    const accepted = await probe(r, 'stop');
    // A concurrent stop may already have closed the socket but not removed state.
    // Wait for that same instance to disappear; never signal an unverified PID.
    for (let i = 0; i < 50; i++) {
      if ((await saved())?.instanceId !== r.instanceId) return output({ ok: true, code: 'stopped' });
      if (!alive(r.pid)) { await clearOwned(r.instanceId); return output({ ok: true, code: 'stale_state_removed' }); }
      await sleep(100);
    }
    if (!accepted) throw error('runtime_unavailable', 'Recorded process cannot be verified; it was not signalled.', 'status');
    throw error('stop_timeout', 'Stop was accepted but cleanup has not completed.', 'status');
  }
  return start(opts, port);
}
main().catch(e => {
  const known = { EADDRINUSE: ['port_in_use', 'Port is already in use.', 'choose_another_port'], EACCES: ['permission_denied', 'Filesystem or port permission denied.', 'inspect_permissions'], ENOENT: ['path_missing', 'A required parent directory does not exist.', 'create_parent_directory'] }[e.code];
  const code = known?.[0] ?? (e.next_action !== undefined ? e.code : 'operation_failed');
  const message = known?.[1] ?? (e.next_action !== undefined ? e.message : 'Operation failed; check private paths and permissions.');
  const result = { ok: false, code, message, next_action: known?.[2] ?? e.next_action ?? 'doctor' };
  if (json || process.connected) output(result);
  else console.error(`codex-gateway: ${message}`);
  process.exitCode = code === 'invalid_arguments' ? 2 : 1;
});
