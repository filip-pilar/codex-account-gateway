import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, readLimits, validateLimits } from '../src/limits.mjs';

test('transport limits default without writes and accept private profile overrides', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gateway-limits-')));
  const path = join(root, 'limits.json');
  try {
    assert.deepEqual(await readLimits(root), DEFAULT_LIMITS);
    await assert.rejects(access(path));
    await writeFile(path, JSON.stringify({ max_request_bytes: 1024 * 1024 * 1024, idle_timeout_ms: 1800000 }), { mode: 0o600 });
    assert.deepEqual(await readLimits(root), { max_request_bytes: 1073741824, idle_timeout_ms: 1800000, max_header_bytes: 1048576 });
    await rm(path); await symlink(join(root, 'missing'), path);
    await assert.rejects(readLimits(root), { code: 'invalid_limits' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid transport settings fail explicitly instead of disabling limits or overflowing timers', () => {
  for (const value of [null, [], 5, { unknown: 1 }, { max_request_bytes: 0 }, { idle_timeout_ms: -1 },
    { idle_timeout_ms: 2 ** 31 }, { max_header_bytes: 2 ** 31 }, { max_request_bytes: 1.5 },
    { max_request_bytes: Number.MAX_SAFE_INTEGER + 1 }, { idle_timeout_ms: '900000' }]) {
    assert.throws(() => validateLimits(value), { code: 'invalid_limits' });
  }
});
