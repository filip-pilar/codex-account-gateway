import test from 'node:test';
import assert from 'node:assert/strict';
import { changeOpenaiRoute, openaiRouteState } from '../src/openai-route.mjs';

const current = `model_provider = "codex-gateway"
model = "gpt-6-sol"
[model_providers.codex-gateway]
base_url = "http://127.0.0.1:8787/v1"
requires_openai_auth = true
`;

test('built-in OpenAI override coexists with the selected custom provider and reverses exactly', () => {
  const enabled = changeOpenaiRoute(current, true, 8787);
  assert.deepEqual(openaiRouteState(enabled), { enabled: true, port: 8787 });
  assert.match(enabled, /^# codex-gateway: built-in openai route begin\nopenai_base_url = "http:\/\/127\.0\.0\.1:8787\/v1"\n/);
  assert.match(enabled, /model_provider = "codex-gateway"/);
  assert.equal(changeOpenaiRoute(enabled, true, 8787), enabled);
  assert.equal(changeOpenaiRoute(enabled, false), current);
  assert.equal(changeOpenaiRoute(current, false), current);
});

test('built-in OpenAI override refuses existing settings and modified managed blocks', () => {
  assert.throws(() => changeOpenaiRoute('openai_base_url = "https://example.test/v1"\n', true, 8787), { code: 'openai_route_conflict' });
  assert.throws(() => changeOpenaiRoute('"openai_base_url" = "https://example.test/v1"\n', true, 8787), { code: 'openai_route_conflict' });
  const enabled = changeOpenaiRoute(current, true, 8787);
  assert.throws(() => changeOpenaiRoute(enabled, true, 8788), { code: 'openai_route_conflict' });
  assert.throws(() => changeOpenaiRoute(enabled.replace('127.0.0.1', '0.0.0.0'), false), { code: 'openai_route_conflict' });
  assert.throws(() => changeOpenaiRoute(enabled.replace('model_provider =', 'openai_base_url = "https://other.test"\nmodel_provider ='), false), { code: 'openai_route_conflict' });
});
