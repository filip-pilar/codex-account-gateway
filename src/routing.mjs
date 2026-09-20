import { listAccounts, selectedAccount, accountRoot, selectAccount, accountError } from './accounts.mjs';
import { readAuth } from './state.mjs';
import { readUsage } from './usage.mjs';

export const WEEKLY_RESERVE = 5;
export const CHECK_INTERVAL_MS = 60_000;
const MAX_USAGE_AGE_MS = 5 * 60_000;

export function weeklyWindow(usage) {
  const buckets = usage?.buckets ?? [];
  const bucket = buckets.find(item => item.id === 'codex') ?? (buckets.length === 1 ? buckets[0] : null);
  return [bucket?.primary, bucket?.secondary].find(window => window?.window_minutes === 10080) ?? null;
}

// Usage and routing stay in the backend, even when the menu is closed. The only
// persisted routing state is the selected profile; credentials are read afresh
// for each request and are never retained in the usage cache.
export function createRouter({ root, usage = readUsage, now = Date.now, intervalMs = CHECK_INTERVAL_MS,
  select = id => selectAccount(root, id) }) {
  const snapshots = new Map(), cancellation = new AbortController();
  let accounts = [], checking, timer, closed = false, queue = Promise.resolve();
  let state = 'checking_usage', account = null;

  const serial = fn => {
    const result = queue.then(fn);
    queue = result.catch(() => {});
    return result;
  };
  const freshWindow = id => {
    const snapshot = snapshots.get(id);
    if (!snapshot || now() - snapshot.at >= MAX_USAGE_AGE_MS) return null;
    const window = weeklyWindow(snapshot.usage);
    if (!Number.isFinite(window?.remaining_percent)) return null;
    // A reset time passing isn't evidence of fresh quota. Read it again.
    if (window.resets_at != null && window.resets_at * 1000 <= now()) return null;
    return window;
  };
  async function choose() {
    if (closed) throw accountError('usage_unavailable', 'Gateway is stopping.');
    account = (await selectedAccount(root)).id;
    const start = Math.max(0, accounts.findIndex(item => item.id === account));
    const ordered = [...accounts.slice(start), ...accounts.slice(0, start)];
    for (const candidate of ordered) {
      if (!candidate.authenticated || !(freshWindow(candidate.id)?.remaining_percent > WEEKLY_RESERVE)) continue;
      let auth;
      try { auth = await readAuth(accountRoot(root, candidate.id), { create: false }); }
      catch { candidate.authenticated = false; continue; }
      if (closed) throw accountError('usage_unavailable', 'Gateway is stopping.');
      if (candidate.id !== account) await select(candidate.id);
      account = candidate.id;
      state = 'ready';
      return auth;
    }
    const signedIn = accounts.filter(item => item.authenticated);
    state = !signedIn.length ? 'login_required'
      : signedIn.every(item => freshWindow(item.id)?.remaining_percent <= WEEKLY_RESERVE)
        ? 'weekly_reserve_reached' : 'usage_unavailable';
    throw accountError(state, state === 'weekly_reserve_reached'
      ? 'All available accounts have reached the 5% weekly reserve.'
      : state === 'login_required' ? 'Sign in to an account.' : 'Fresh weekly usage is unavailable.');
  }
  function refresh() {
    if (closed) return Promise.resolve();
    if (checking) return checking;
    clearTimeout(timer);
    checking = (async () => {
      try {
        const listing = await listAccounts(root);
        // Limit concurrent official CLI children, including with larger pools.
        const pending = listing.filter(item => item.authenticated);
        await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
          while (!closed && pending.length) {
            const item = pending.shift();
            try {
              const result = await usage(accountRoot(root, item.id), { signal: cancellation.signal });
              if (!closed) snapshots.set(item.id, { usage: result, at: now() });
            } catch {
              // A transient failure can use a recent snapshot until its bounded
              // expiry. Missing/stale usage never becomes invented availability.
            }
          }
        }));
        if (closed) return;
        accounts = listing;
        for (const id of snapshots.keys()) if (!listing.some(item => item.id === id)) snapshots.delete(id);
        await serial(choose);
      } catch (error) {
        state = ['weekly_reserve_reached', 'login_required'].includes(error.code) ? error.code : 'usage_unavailable';
      }
    })().finally(() => {
      checking = null;
      if (!closed) {
        timer = setTimeout(refresh, intervalMs);
        timer.unref();
      }
    });
    return checking;
  }
  return {
    refresh,
    status: () => ({ mode: 'automatic', weekly_reserve_percent: WEEKLY_RESERVE, state, account }),
    async credentials() {
      if (!accounts.length || !accounts.some(item => item.authenticated && freshWindow(item.id))) await refresh();
      return serial(choose);
    },
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
