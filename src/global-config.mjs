import { open, lstat, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { noSymlinkParents } from './state.mjs';
import { changeOpenaiRoute, openaiRouteState } from './openai-route.mjs';

const choiceStart = '# codex-gateway: global provider begin';
const choiceEnd = '# codex-gateway: global provider end';
const tableStart = '# codex-gateway: provider definition begin';
const tableEnd = '# codex-gateway: provider definition end';
const failure = (code, message) => Object.assign(new Error(message), { code, next_action: 'inspect_global_config' });
export const globalConfigPath = () => join(homedir(), '.codex', 'config.toml');

export function gatewayProvider(port, requiresOpenAIAuth = false) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw failure('invalid_arguments', 'Invalid gateway port.');
  return `[model_providers.codex-gateway]
name = "OpenAI"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = ${requiresOpenAIAuth}
supports_websockets = false
supports_standalone_web_search = true
http_headers = { "x-openai-actor-authorization" = "codex-gateway" }
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 240000
`;
}

function inspect(source) {
  const lines = source.split('\n');
  const chosen = lines.findIndex(line => line === choiceStart);
  const defined = lines.findIndex(line => line === tableStart);
  const managed = chosen >= 0 && defined >= 0;
  if ((chosen >= 0) !== (defined >= 0) || (managed &&
      (lines.filter(line => line === choiceStart).length !== 1 || lines.filter(line => line === tableStart).length !== 1)))
    throw failure('global_config_conflict', 'Gateway configuration markers are incomplete.');
  if (managed) {
    const select = lines.slice(chosen, chosen + 4);
    const old = select[1]?.match(/^# previous-provider-base64: ([A-Za-z0-9+/=]*)$/)?.[1];
    if (old === undefined || select[2] !== 'model_provider = "codex-gateway"' || select[3] !== choiceEnd)
      throw failure('global_config_conflict', 'Gateway provider selection has changed.');
    const end = lines.indexOf(tableEnd, defined + 1);
    if (end < 0) throw failure('global_config_conflict', 'Gateway provider definition is incomplete.');
    const provider = lines.slice(defined + 1, end).join('\n') + '\n';
    const port = Number(provider.match(/^base_url = "http:\/\/127\.0\.0\.1:(\d+)\/v1"$/m)?.[1]);
    const openaiAuth = provider === gatewayProvider(port, true);
    if (!Number.isInteger(port) || (!openaiAuth && provider !== gatewayProvider(port)) ||
        Buffer.from(old, 'base64').toString('base64') !== old)
      throw failure('global_config_conflict', 'Gateway provider definition has changed.');
    return { enabled: true, port, openaiAuth, previous: Buffer.from(old, 'base64').toString(), lines, chosen, defined, end };
  }
  if (/^\s*\[model_providers\.(?:"codex-gateway"|codex-gateway)\]\s*$/m.test(source) ||
      /^\s*model_provider\s*=\s*["']codex-gateway["']\s*$/m.test(source))
    throw failure('global_config_conflict', 'An unmanaged gateway provider already exists.');
  return { enabled: false, lines };
}

export function globalConfigState(source) {
  const state = inspect(source);
  const route = openaiRouteState(source);
  const enabled = state.enabled || route.enabled;
  return {
    enabled, port: state.port ?? route.port, openai_auth: state.openaiAuth ?? null,
    needs_update: enabled && !(state.enabled && route.enabled && state.port === route.port && state.openaiAuth),
  };
}

export function changeGlobalConfig(source, enabled, port) {
  // Validate both routes before changing either, then commit them in one write.
  globalConfigState(source);
  const withoutRoute = changeOpenaiRoute(source, false);
  const updated = changeProvider(withoutRoute, enabled, port);
  return changeOpenaiRoute(updated, enabled, port);
}

function changeProvider(source, enabled, port) {
  const state = inspect(source);
  if (state.enabled && enabled) {
    if (state.openaiAuth && state.port === port) return source;
    const lines = state.lines;
    lines.splice(state.defined + 1, state.end - state.defined - 1, ...gatewayProvider(port, true).trimEnd().split('\n'));
    return lines.join('\n');
  }
  if (!state.enabled && !enabled) return source;
  if (enabled) {
    const lines = state.lines;
    const firstTable = lines.findIndex(line => /^\s*\[/.test(line));
    const rootEnd = firstTable < 0 ? lines.length : firstTable;
    const matches = lines.slice(0, rootEnd).map((line, index) => /^\s*model_provider\s*=/.test(line) ? index : -1).filter(index => index >= 0);
    if (matches.length > 1 || (matches.length === 1 && !/^model_provider\s*=\s*["'][A-Za-z0-9_-]+["'](?:\s*#.*)?$/.test(lines[matches[0]])))
      throw failure('global_config_conflict', 'Existing provider selection needs manual inspection.');
    const previous = matches.length ? lines[matches[0]] : '';
    const block = [choiceStart, `# previous-provider-base64: ${Buffer.from(previous).toString('base64')}`, 'model_provider = "codex-gateway"', choiceEnd];
    lines.splice(matches.length ? matches[0] : 0, matches.length ? 1 : 0, ...block);
    const prefix = lines.join('\n').replace(/\n*$/, '\n\n');
    return prefix + tableStart + '\n' + gatewayProvider(port, true) + tableEnd + '\n';
  }
  const lines = state.lines;
  const before = lines.slice(0, state.chosen);
  const after = lines.slice(state.chosen + 4, state.defined);
  if (state.previous) before.push(state.previous);
  return [...before, ...after].join('\n').replace(/\n*$/, '\n') + lines.slice(state.end + 1).join('\n');
}

async function readConfig(path) {
  await noSymlinkParents(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw failure('global_config_unsafe', 'Global Codex config is not a regular file under 1 MiB.');
    return { source: await handle.readFile('utf8'), stat };
  } finally { await handle.close(); }
}

export async function readGlobalConfig(path = globalConfigPath()) {
  try { return { path, ...globalConfigState((await readConfig(path)).source) }; }
  catch (error) { if (error.code === 'ENOENT') return { path, ...globalConfigState('') }; throw error; }
}

export async function setGlobalConfig(enabled, port, path = globalConfigPath()) {
  const { source, stat } = await readConfig(path);
  const updated = changeGlobalConfig(source, enabled, port);
  if (updated === source) return { path, ...globalConfigState(source) };
  const temporary = `${path}.gateway-${randomBytes(12).toString('hex')}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, stat.mode & 0o777);
  try {
    await handle.writeFile(updated);
    await handle.close();
    const current = await readConfig(path);
    if (createHash('sha256').update(current.source).digest('hex') !== createHash('sha256').update(source).digest('hex'))
      throw failure('global_config_changed', 'Global Codex config changed during the update.');
    const target = await lstat(path);
    if (!target.isFile() || target.isSymbolicLink()) throw failure('global_config_unsafe', 'Global Codex config changed type.');
    await rename(temporary, path);
  } finally { await handle.close(); await unlink(temporary).catch(() => {}); }
  return { path, ...globalConfigState(updated) };
}
