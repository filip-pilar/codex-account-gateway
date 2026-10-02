import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeGlobalConfig, readGlobalConfig, setGlobalConfig } from '../src/global-config.mjs';

test('global config update preserves private permissions and supports reversal', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'gateway-global-')));
  const path = join(dir, 'config.toml');
  const source = 'model_provider = "other"\n[model_providers.other]\nname = "Other"\n';
  try {
    await writeFile(path, source, { mode: 0o600 });
    assert.equal((await readGlobalConfig(path)).enabled, false);
    assert.equal((await setGlobalConfig(true, 8787, path)).enabled, true);
    const enabled = await readFile(path, 'utf8');
    await setGlobalConfig(true, 8787, path);
    assert.equal(await readFile(path, 'utf8'), enabled);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await setGlobalConfig(false, undefined, path)).enabled, false);
    assert.equal(await readFile(path, 'utf8'), source);
    const link = join(dir, 'linked.toml');
    await symlink(path, link);
    await assert.rejects(setGlobalConfig(true, 8787, link));
    assert.equal(await readFile(path, 'utf8'), source);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a conflict in either route leaves the entire config untouched', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'gateway-global-conflict-')));
  const path = join(dir, 'config.toml');
  try {
    const enabled = changeGlobalConfig('model = "fixture"\n', true, 8787);
    for (const changed of [
      'model_provider = "codex-gateway"\n',
      '[model_providers.codex-gateway]\nname = "Other"\n',
      'openai_base_url = "https://example.test/v1"\n',
      '"openai_base_url" = "https://example.test/v1"\n',
      enabled.replace('openai_base_url = "http://127.0.0.1:8787/v1"', 'openai_base_url = "https://other.test/v1"'),
      enabled.replace('wire_api = "responses"', 'wire_api = "chat"'),
    ]) {
      await writeFile(path, changed, { mode: 0o600 });
      await assert.rejects(setGlobalConfig(false, undefined, path));
      await assert.rejects(setGlobalConfig(true, 8787, path));
      assert.equal(await readFile(path, 'utf8'), changed);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
