const begin = '# codex-gateway: built-in openai route begin';
const end = '# codex-gateway: built-in openai route end';
const conflict = () => Object.assign(new Error('The built-in OpenAI route needs manual config inspection.'), {
  code: 'openai_route_conflict', next_action: 'inspect_global_config',
});
const block = port => `${begin}\nopenai_base_url = "http://127.0.0.1:${port}/v1"\n${end}\n`;

function rootHasOverride(source) {
  const root = source.split(/\r?\n/).filter(line => !/^\s*#/.test(line));
  const firstTable = root.findIndex(line => /^\s*\[/.test(line));
  return root.slice(0, firstTable < 0 ? undefined : firstTable)
    .some(line => /^\s*(?:openai_base_url|"openai_base_url"|'openai_base_url')\s*=/.test(line));
}

export function openaiRouteState(source) {
  const starts = source.split(begin).length - 1;
  const ends = source.split(end).length - 1;
  if (starts !== ends || starts > 1) throw conflict();
  if (!starts) {
    if (rootHasOverride(source)) throw conflict();
    return { enabled: false, port: null };
  }
  const match = /^# codex-gateway: built-in openai route begin\nopenai_base_url = "http:\/\/127\.0\.0\.1:(\d+)\/v1"\n# codex-gateway: built-in openai route end\n/.exec(source);
  const port = Number(match?.[1]);
  if (!match || !Number.isInteger(port) || port < 1024 || port > 65535 || rootHasOverride(source.slice(match[0].length))) throw conflict();
  return { enabled: true, port };
}

export function changeOpenaiRoute(source, enabled, port) {
  const state = openaiRouteState(source);
  if (!enabled) return state.enabled ? source.slice(block(state.port).length) : source;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw Object.assign(new Error('Port must be 1024–65535.'), { code: 'invalid_arguments' });
  }
  if (state.enabled) {
    if (state.port !== port) throw conflict();
    return source;
  }
  if (source.charCodeAt(0) === 0xfeff) throw conflict();
  return block(port) + source;
}
