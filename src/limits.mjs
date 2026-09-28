import { join } from 'node:path';
import { readPrivate } from './state.mjs';

// Limits apply to the transport, never the decoded conversation or its schema.
export const DEFAULT_LIMITS = Object.freeze({
  max_request_bytes: 256 * 1024 * 1024,
  idle_timeout_ms: 15 * 60_000,
  max_header_bytes: 1024 * 1024,
});

export function validateLimits(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.entries(value).some(([key, number]) => !Object.hasOwn(DEFAULT_LIMITS, key) ||
        !Number.isSafeInteger(number) || number <= 0 ||
        (key !== 'max_request_bytes' && number > 2 ** 31 - 1))) {
    throw Object.assign(new Error('limits.json must contain positive integer transport limits. See docs/cli.md.'), {
      code: 'invalid_limits', next_action: 'inspect_private_state',
    });
  }
  return { ...DEFAULT_LIMITS, ...value };
}

export async function readLimits(root) {
  let value;
  try { value = await readPrivate(join(root, 'limits.json')); }
  catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULT_LIMITS };
    throw Object.assign(new Error('limits.json is unreadable or unsafe. See docs/cli.md.'), {
      code: 'invalid_limits', next_action: 'inspect_private_state',
    });
  }
  return validateLimits(value);
}
