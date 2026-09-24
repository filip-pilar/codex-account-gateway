import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { changeOpenaiRoute } from '../src/openai-route.mjs';
import { changeGlobalConfig, globalConfigState, readGlobalConfig, setGlobalConfig } from '../src/global-config.mjs';

test('global provider toggle preserves other settings and restores prior selection', () => {
  for (const source of [
    'model = "gpt-6-sol"\n\n[model_providers.devin_astra]\nbase_url = "http://example.test"\n',
    'model_provider = "devin_astra" # keep this choice\n[model_providers.devin_astra]\nname = "Other"\n',
  ]) {
    const enabled = changeGlobalConfig(source, true, 8787);
    assert.deepEqual(globalConfigState(enabled), { enabled: true, port: 8787, openai_auth: true, needs_update: false });
    assert.match(enabled, /base_url = "http:\/\/127\.0\.0\.1:8787\/v1"/);
    assert.equal(changeGlobalConfig(enabled, true, 8787), enabled);
    assert.equal(changeGlobalConfig(enabled, false), source);
  }
});

test('global provider upgrades an existing managed definition without changing other settings', () => {
  const source = 'model_provider = "devin_astra"\nmodel = "gpt-6-sol"\n';
  const legacy = changeGlobalConfig(source, true, 8787).replace('requires_openai_auth = true', 'requires_openai_auth = false');
  assert.deepEqual(globalConfigState(legacy), { enabled: true, port: 8787, openai_auth: false, needs_update: true });
  const updated = changeGlobalConfig(legacy, true, 8787);
  assert.deepEqual(globalConfigState(updated), { enabled: true, port: 8787, openai_auth: true, needs_update: false });
  assert.equal(changeGlobalConfig(updated, false), source);
});

test('disabling the global provider preserves settings added after its managed block', () => {
  const source = 'model = "fixture"\n';
  const added = '\n[projects.fixture]\ntrust_level = "trusted"\n';
  const enabled = changeGlobalConfig(source, true, 8787) + added;
  assert.equal(changeGlobalConfig(enabled, false), source + added);
});

test('global provider toggle refuses ambiguous or edited configuration', () => {
  assert.throws(() => changeGlobalConfig('model_provider = "codex-gateway"\n', true, 8787), { code: 'global_config_conflict' });
  assert.throws(() => changeGlobalConfig('[model_providers.codex-gateway]\nname = "Other"\n', true, 8787), { code: 'global_config_conflict' });
  const enabled = changeGlobalConfig('model = "gpt-6-sol"\n', true, 8787);
  assert.throws(() => changeGlobalConfig(enabled.replace('request_max_retries = 0', 'request_max_retries = 9'), false), { code: 'global_config_conflict' });
});

test('global config update preserves private permissions and supports reversal', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'gateway-global-')));
  const path = join(dir, 'config.toml');
  const source = 'model = "gpt-6-sol"\n';
  try {
    await writeFile(path, source, { mode: 0o600 });
    assert.equal((await readGlobalConfig(path)).enabled, false);
    assert.equal((await setGlobalConfig(true, 8787, path)).enabled, true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await setGlobalConfig(false, undefined, path)).enabled, false);
    assert.equal(await readFile(path, 'utf8'), source);
    const link = join(dir, 'linked.toml');
    await symlink(path, link);
    await assert.rejects(setGlobalConfig(true, 8787, link));
    assert.equal(await readFile(path, 'utf8'), source);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('either legacy route is shown as enabled and can be repaired or fully disabled', () => {
  const source = 'model_provider = "other"\nmodel = "fixture"\n';
  const complete = changeGlobalConfig(source, true, 8787);
  for (const partial of [changeOpenaiRoute(complete, false), changeOpenaiRoute(source, true, 8787)]) {
    assert.equal(globalConfigState(partial).enabled, true);
    assert.equal(globalConfigState(partial).needs_update, true);
    assert.equal(changeGlobalConfig(partial, false), source);
    assert.equal(changeGlobalConfig(partial, true, 8787), complete);
  }
  const moved = changeGlobalConfig(complete, true, 8788);
  assert.equal(globalConfigState(moved).needs_update, false);
  assert.equal((moved.match(/127\.0\.0\.1:8788\/v1/g) ?? []).length, 2);
  assert.equal(changeGlobalConfig(moved, false), source);
});

test('a conflict in either route leaves the entire config untouched', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'gateway-global-conflict-')));
  const path = join(dir, 'config.toml');
  try {
    const enabled = changeGlobalConfig('model = "fixture"\n', true, 8787);
    for (const changed of [
      enabled.replace('openai_base_url = "http://127.0.0.1:8787/v1"', 'openai_base_url = "https://other.test/v1"'),
      enabled.replace('request_max_retries = 0', 'request_max_retries = 9'),
    ]) {
      await writeFile(path, changed, { mode: 0o600 });
      await assert.rejects(setGlobalConfig(false, undefined, path));
      await assert.rejects(setGlobalConfig(true, 8787, path));
      assert.equal(await readFile(path, 'utf8'), changed);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy CLI names share the same connection switch and preserve response codes', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'gateway-connection-cli-')));
  const path = join(dir, '.codex', 'config.toml');
  const source = 'model = "fixture"\n';
  const run = async command => JSON.parse((await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), command, '--json'],
    { env: { ...process.env, HOME: dir, CODEX_GATEWAY_HOME: join(dir, 'backing') } })).stdout);
  try {
    await mkdir(join(dir, '.codex'), { mode: 0o700 });
    await writeFile(path, source, { mode: 0o600 });
    assert.equal((await run('openai-route-enable')).code, 'openai_route_enabled');
    assert.equal((await run('global-status')).global.needs_update, false);
    assert.equal((await run('global-disable')).global.enabled, false);
    assert.equal(await readFile(path, 'utf8'), source);
    assert.equal((await run('global-enable')).global.needs_update, false);
    assert.equal((await run('openai-route-status')).route.enabled, true);
    assert.equal((await run('openai-route-disable')).route.enabled, false);
    assert.equal(await readFile(path, 'utf8'), source);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
