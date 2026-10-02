import { listAccounts, selectedAccount, accountRoot, selectAccount, accountError, writeCreditFallback } from './accounts.mjs';
import { readAuth } from './state.mjs';
import { writeReserveUsage } from './reserve.mjs';
import { readUsage } from './usage.mjs';

export const WEEKLY_RESERVE = 5;
export const CHECK_INTERVAL_MS = 60_000;
const MAX_USAGE_AGE_MS = 5 * 60_000;
const failureCategories = new Set(['timeout', 'cli_unavailable', 'login_required', 'cancelled',
  'child_exit', 'pipe_error', 'output_limit', 'invalid_response', 'rpc_error']);

export function coreBucket(usage) {
  const buckets = usage?.buckets ?? [];
  return buckets.find(item => item.id === 'codex') ?? (buckets.length === 1 ? buckets[0] : null);
}
export function weeklyWindow(usage) {
  const bucket = coreBucket(usage);
  return [bucket?.primary, bucket?.secondary].find(window => window?.window_minutes === 10080) ?? null;
}

// Usage is advisory for availability. A confirmed reserve remains in effect until
// a valid new reading clears it; missing data never creates quota or blocks an
// otherwise eligible account. Credentials are read locally for each request.
export function createRouter({ root, usage = readUsage, now = Date.now, intervalMs = CHECK_INTERVAL_MS,
  allowReserveUsage = false, select = id => selectAccount(root, id) }) {
  const snapshots = new Map(), diagnostics = new Map(), exhaustions = new Map(), cancellation = new AbortController();
  let checking, timer, closed = false, queue = Promise.resolve(), failedChecks = 0, nextCheckAt = null;
  let state = 'checking_usage', account = null;

  const serial = fn => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const currentWindow = id => weeklyWindow(snapshots.get(id)?.usage);
  const freshWindow = id => {
    const snapshot = snapshots.get(id);
    if (!snapshot || now() - snapshot.at >= MAX_USAGE_AGE_MS) return null;
    const window = currentWindow(id);
    if (!Number.isFinite(window?.remaining_percent)) return null;
    if (window.resets_at != null && window.resets_at * 1000 <= now()) return null;
    return window;
  };
  const atReserve = id => currentWindow(id)?.remaining_percent <= WEEKLY_RESERVE;
  const exhausted = id => (exhaustions.get(id)?.size ?? 0) > 0;
  const degraded = id => !freshWindow(id) || !!diagnostics.get(id)?.last_error;
  const creditEligible = item => {
    const bucket = coreBucket(snapshots.get(item.id)?.usage);
    const credits = bucket?.credits;
    return item.allow_credit_fallback && !degraded(item.id) &&
      ![bucket?.primary, bucket?.secondary].some(window => window?.resets_at != null && window.resets_at * 1000 <= now()) &&
      (credits?.unlimited === true || credits?.has_credits === true && credits.balance !== 0);
  };
  const status = () => ({ mode: 'automatic', weekly_reserve_percent: WEEKLY_RESERVE, allow_reserve_usage: allowReserveUsage,
    state: state === 'ready' && degraded(account) ? 'usage_degraded' : state, account });

  async function choose() {
    if (closed) throw accountError('usage_unavailable', 'Gateway is stopping.');
    const accounts = await listAccounts(root);
    account = (await selectedAccount(root)).id;
    const start = Math.max(0, accounts.findIndex(item => item.id === account));
    const ordered = [...accounts.slice(start), ...accounts.slice(0, start)];
    const eligible = ordered.filter(item => item.authenticated && !atReserve(item.id) && !exhausted(item.id));
    // Keep the selected account even if its telemetry fails. When switching,
    // prefer a fresh positive reading over an account with unknown usage.
    const candidates = [
      ...eligible.filter(item => item.id === account),
      ...eligible.filter(item => item.id !== account && freshWindow(item.id)),
      ...eligible.filter(item => item.id !== account && !freshWindow(item.id)),
      ...(allowReserveUsage ? ordered.filter(item => item.authenticated && atReserve(item.id) && !exhausted(item.id)) : []),
    ];
    const fallback = ordered.filter(item => item.authenticated && creditEligible(item) && !candidates.includes(item));
    for (const candidate of [...candidates, ...fallback]) {
      let auth;
      try { auth = await readAuth(accountRoot(root, candidate.id), { create: false }); }
      catch { candidate.authenticated = false; continue; }
      if (closed) throw accountError('usage_unavailable', 'Gateway is stopping.');
      if (candidate.id !== account) await select(candidate.id);
      account = candidate.id;
      state = fallback.includes(candidate) ? 'credit_fallback' : degraded(account) ? 'usage_degraded' : 'ready';
      return auth;
    }
    state = !accounts.some(item => item.authenticated) ? 'login_required'
      : accounts.some(item => item.authenticated && exhausted(item.id)) ? 'usage_limit_reached' : 'weekly_reserve_reached';
    throw accountError(state, state === 'login_required' ? 'Sign in to an account.'
      : 'No account has eligible included usage or permitted credit fallback.');
  }
  function refresh() {
    if (closed) return Promise.resolve();
    if (checking) return checking;
    clearTimeout(timer);
    nextCheckAt = null;
    checking = (async () => {
      let succeeded = false;
      try {
        const listing = await listAccounts(root);
        const pending = listing.filter(item => item.authenticated);
        await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (!closed && pending.length) {
            const item = pending.shift();
            const previous = diagnostics.get(item.id);
            const diagnostic = { last_attempt_at: new Date(now()).toISOString(),
              last_success_at: previous?.last_success_at ?? null, last_error: previous?.last_error ?? null,
              consecutive_failures: previous?.consecutive_failures ?? 0 };
            diagnostics.set(item.id, diagnostic);
            try {
              const result = await usage(accountRoot(root, item.id), { signal: cancellation.signal });
              if (closed) return;
              // A missing window or elapsed reset must not clear a confirmed
              // exhaustion. Only a fresh reading of the same window can do so.
              const blocked = exhaustions.get(item.id) ?? new Set();
              const bucket = coreBucket(result);
              for (const slot of ['primary', 'secondary']) {
                const reported = bucket?.[slot];
                if (!Number.isFinite(reported?.remaining_percent) ||
                    reported.resets_at != null && reported.resets_at * 1000 <= now()) continue;
                const key = reported.window_minutes ?? slot;
                // Fresh data replaces a provisional key recorded without a duration.
                blocked.delete(slot);
                if (reported.remaining_percent <= 0) blocked.add(key);
                else blocked.delete(key);
              }
              exhaustions.set(item.id, blocked);
              const window = weeklyWindow(result);
              if (!Number.isFinite(window?.remaining_percent)) {
                // Preserve a good snapshot, but allow short-window details on a
                // first read for accounts that do not report a weekly window.
                if (!snapshots.has(item.id)) snapshots.set(item.id, { usage: result, at: now() });
                diagnostic.last_error = 'missing_weekly_window';
              } else if (window.resets_at != null && window.resets_at * 1000 <= now()) {
                diagnostic.last_error = 'stale_response';
              } else {
                snapshots.set(item.id, { usage: result, at: now() });
                diagnostic.last_success_at = new Date(now()).toISOString();
                diagnostic.last_error = null;
                diagnostic.consecutive_failures = 0;
                succeeded = true;
              }
            } catch (error) {
              diagnostic.last_error = failureCategories.has(error.category) ? error.category
                : error.code === 'usage_timeout' ? 'timeout'
                : failureCategories.has(error.code) ? error.code : 'usage_unavailable';
            }
            if (diagnostic.last_error) diagnostic.consecutive_failures++;
          }
        }));
        if (closed) return;
        for (const cache of [snapshots, diagnostics, exhaustions]) {
          for (const id of cache.keys()) if (!listing.some(item => item.id === id)) cache.delete(id);
        }
        await serial(choose);
      } catch (error) {
        state = ['weekly_reserve_reached', 'usage_limit_reached', 'login_required'].includes(error.code) ? error.code : 'usage_unavailable';
      } finally {
        failedChecks = succeeded ? 0 : Math.min(failedChecks + 1, 4);
      }
    })().finally(() => {
      checking = null;
      if (!closed) {
        const delay = Math.min(intervalMs * 2 ** Math.max(0, failedChecks - 1), 5 * 60_000);
        nextCheckAt = new Date(now() + delay).toISOString();
        timer = setTimeout(refresh, delay);
        timer.unref();
      }
    });
    return checking;
  }
  return {
    refresh,
    status,
    setAllowReserveUsage(enabled) {
      return serial(async () => {
        if (closed) throw accountError('usage_unavailable', 'Gateway is stopping.');
        await writeReserveUsage(root, enabled);
        allowReserveUsage = enabled;
        try { await choose(); }
        catch (error) {
          if (!['weekly_reserve_reached', 'usage_limit_reached', 'login_required'].includes(error.code)) throw error;
        }
        return status();
      });
    },
    setCreditFallback(id, enabled) {
      return serial(async () => {
        if (closed) throw accountError('usage_unavailable', 'Gateway is stopping.');
        await writeCreditFallback(root, id, enabled);
        try { await choose(); }
        catch (error) {
          if (!['weekly_reserve_reached', 'usage_limit_reached', 'login_required'].includes(error.code)) throw error;
        }
        return { account: id, allow_credit_fallback: enabled, routing: status() };
      });
    },
    async usageStatus() {
      const accounts = await listAccounts(root);
      return { checking: !!checking, next_check_at: nextCheckAt, accounts: accounts.map(item => ({
        account: item.id, checked_at: snapshots.get(item.id)?.usage.checked_at ?? null,
        buckets: snapshots.get(item.id)?.usage.buckets ?? [], stale: degraded(item.id),
        included_usage_exhausted: exhausted(item.id),
        diagnostics: diagnostics.get(item.id) ?? { last_attempt_at: null, last_success_at: null,
          last_error: null, consecutive_failures: 0 },
      })) };
    },
    credentials: () => serial(choose),
    async select(id) {
      return serial(async () => {
        await select(id);
        account = id;
        state = 'checking_usage';
      });
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      cancellation.abort();
      await checking;
      await queue;
    },
  };
}
