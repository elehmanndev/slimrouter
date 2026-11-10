import { listConnections, patchConnectionData, type Connection } from "./connections";
import { strategyFor } from "./settings";
import { fetchQuota, guardWindows, readSnapshot } from "./quota";
import { getProvider } from "./providers/registry";

export interface SelectResult {
  connection: Connection | null;
  reason: string;
  retryAfter?: string | null;
}

const BACKOFF_BASE_MS = 2000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const BACKOFF_MAX_LEVEL = 15;
const TRANSIENT_MS = 30 * 1000;
const AUTH_MS = 2 * 60 * 1000;
const MAX_UPSTREAM_RESET_MS = 30 * 60 * 1000;

let mutex: Promise<void> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = mutex.then(fn, fn);
  mutex = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function lockActive(c: Connection, model: string | null): string | null {
  const now = Date.now();
  const until = c.data.lockedUntil ? Date.parse(c.data.lockedUntil) : 0;
  if (until > now) return c.data.lockedUntil!;
  if (model) {
    const m = c.data.modelLocks?.[model];
    if (m && Date.parse(m) > now) return m;
  }
  return null;
}

/**
 * Quota guard: an account is skipped when the remaining percentage of its 5h or weekly
 * window is below the provider's threshold. Snapshots are refreshed in the background.
 */
function quotaBlocked(c: Connection, model: string | null): { blocked: boolean; until: string | null; reason: string } {
  const strat = strategyFor(c.provider);
  const provider = getProvider(c.provider);
  if (!provider?.quota || c.authType !== "oauth") return { blocked: false, until: null, reason: "" };
  const snap = readSnapshot(c.id);
  if (!snap) {
    void fetchQuota(c);
    return { blocked: false, until: null, reason: "" };
  }
  void fetchQuota(c); // refresh if the cached snapshot is stale (ttl handled inside)
  const { session, weekly } = guardWindows(snap, model);
  const now = Date.now();
  const check = (w: typeof session, min: number, label: string) => {
    if (!w || min <= 0) return null;
    if (w.resetAt && Date.parse(w.resetAt) <= now) return null; // window already reset
    if (w.remainingPercent < min) return { until: w.resetAt, reason: `${label} window ${w.remainingPercent.toFixed(0)}% left (< ${min}%)` };
    return null;
  };
  const hit = check(session, strat.minRemainingSessionPercent, "5h") || check(weekly, strat.minRemainingWeeklyPercent, "weekly");
  return hit ? { blocked: true, ...hit } : { blocked: false, until: null, reason: "" };
}

export async function selectConnection(providerId: string, model: string | null, exclude: Set<string>): Promise<SelectResult> {
  return withLock(async () => {
    const all = listConnections({ provider: providerId, activeOnly: true });
    if (all.length === 0) return { connection: null, reason: `No active account for ${providerId}` };
    const waits: string[] = [];
    const reasons: string[] = [];
    const available = all.filter((c) => {
      if (exclude.has(c.id)) return false;
      const lock = lockActive(c, model);
      if (lock) {
        waits.push(lock);
        reasons.push(`${c.name}: cooling down`);
        return false;
      }
      const q = quotaBlocked(c, model);
      if (q.blocked) {
        if (q.until) waits.push(q.until);
        reasons.push(`${c.name}: ${q.reason}`);
        return false;
      }
      return true;
    });
    if (available.length === 0) {
      const earliest = waits.sort()[0] || null;
      return { connection: null, reason: reasons.join("; ") || "All accounts unavailable", retryAfter: earliest };
    }
    const strat = strategyFor(providerId);
    let chosen: Connection;
    if (strat.strategy === "round-robin") {
      const byRecency = [...available].sort((a, b) => {
        const ta = a.data.lastUsedAt ? Date.parse(a.data.lastUsedAt) : 0;
        const tb = b.data.lastUsedAt ? Date.parse(b.data.lastUsedAt) : 0;
        return tb - ta || a.priority - b.priority;
      });
      const current = byRecency[0];
      const count = current.data.consecutiveUseCount || 0;
      if (current.data.lastUsedAt && count < strat.stickyLimit) {
        chosen = current;
        patchConnectionData(chosen.id, { lastUsedAt: new Date().toISOString(), consecutiveUseCount: count + 1 });
      } else {
        const oldestFirst = [...available].sort((a, b) => {
          const ta = a.data.lastUsedAt ? Date.parse(a.data.lastUsedAt) : 0;
          const tb = b.data.lastUsedAt ? Date.parse(b.data.lastUsedAt) : 0;
          return ta - tb || a.priority - b.priority;
        });
        chosen = oldestFirst[0];
        patchConnectionData(chosen.id, { lastUsedAt: new Date().toISOString(), consecutiveUseCount: 1 });
      }
    } else {
      chosen = available[0]; // already sorted by priority
      patchConnectionData(chosen.id, { lastUsedAt: new Date().toISOString() });
    }
    return { connection: chosen, reason: strat.strategy };
  });
}

export interface FailureVerdict {
  fallback: boolean; // try the next account
  cooldownMs: number;
  requestScoped: boolean; // the request itself is bad, do not punish the account
}

export function classifyFailure(status: number, errorText: string, backoffLevel: number): FailureVerdict & { newBackoffLevel: number } {
  const t = (errorText || "").toLowerCase();
  const backoff = () => {
    const level = Math.min(backoffLevel + 1, BACKOFF_MAX_LEVEL);
    const ms = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, level - 1), BACKOFF_MAX_MS);
    return { fallback: true, cooldownMs: ms, requestScoped: false, newBackoffLevel: level };
  };
  if (/rate limit|too many requests|quota exceeded|insufficient credit|credit balance is too low|capacity|overloaded/.test(t)) return backoff();
  if (status === 429) return backoff();
  if (status === 401 || status === 402 || status === 403 || status === 404) return { fallback: true, cooldownMs: AUTH_MS, requestScoped: false, newBackoffLevel: backoffLevel };
  if (status >= 400 && status < 500) return { fallback: false, cooldownMs: 0, requestScoped: true, newBackoffLevel: backoffLevel };
  return { fallback: true, cooldownMs: TRANSIENT_MS, requestScoped: false, newBackoffLevel: backoffLevel };
}

export function markFailure(c: Connection, model: string | null, status: number, errorText: string, upstreamResetMs?: number | null): FailureVerdict {
  const verdict = classifyFailure(status, errorText, c.data.backoffLevel || 0);
  if (verdict.requestScoped) return verdict;
  let cooldown = verdict.cooldownMs;
  if (upstreamResetMs && upstreamResetMs > Date.now()) cooldown = Math.min(upstreamResetMs - Date.now(), MAX_UPSTREAM_RESET_MS);
  const until = new Date(Date.now() + cooldown).toISOString();
  const patch = {
    backoffLevel: verdict.newBackoffLevel,
    lastError: `[${status}] ${errorText.slice(0, 300)}`,
    lastErrorAt: new Date().toISOString(),
  };
  if (model) patchConnectionData(c.id, { ...patch, modelLocks: { ...(c.data.modelLocks || {}), [model]: until } });
  else patchConnectionData(c.id, { ...patch, lockedUntil: until });
  return { ...verdict, cooldownMs: cooldown };
}

export function markSuccess(c: Connection, model: string | null) {
  const locks = { ...(c.data.modelLocks || {}) };
  if (model) delete locks[model];
  for (const [k, v] of Object.entries(locks)) if (Date.parse(v) <= Date.now()) delete locks[k];
  patchConnectionData(c.id, { backoffLevel: 0, lastError: null, modelLocks: locks, lockedUntil: null });
}
