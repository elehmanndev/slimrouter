import { listConnections } from "./connections";
import { getProvider } from "./providers/registry";
import { readSnapshot, type QuotaWindow } from "./quota";
import { strategyFor } from "./settings";
import { usageSummary, usageTotals } from "./usage";

/**
 * Read-only usage view for clients that hold a client key (Paseo's Usage modal). It mirrors what
 * the dashboard shows without tokens, emails or management rights: per-account windows from the
 * cached quota snapshots, whether the quota guard would skip the account right now, and today's
 * spend. Snapshots refresh in the background as the router uses them.
 */
export interface UsageAccountView {
  id: string;
  provider: string;
  name: string;
  priority: number;
  active: boolean;
  setupToken: boolean;
  reauthRequired: boolean;
  plan: string | null;
  fetchedAt: string | null;
  error: string | null;
  windows: QuotaWindow[];
  guard: { blocked: boolean; reason: string | null; until: string | null };
}

function guardFor(provider: string, windows: QuotaWindow[], now: number): UsageAccountView["guard"] {
  const s = strategyFor(provider);
  const pick = (key: string) => windows.find((w) => w.key === key) || null;
  for (const [w, min, label] of [[pick("session"), s.minRemainingSessionPercent, "5h"], [pick("weekly"), s.minRemainingWeeklyPercent, "weekly"]] as const) {
    if (!w || min <= 0) continue;
    if (w.resetAt && Date.parse(w.resetAt) <= now) continue;
    if (w.remainingPercent < min) return { blocked: true, reason: `${label} window ${Math.round(w.remainingPercent)}% left (< ${min}%)`, until: w.resetAt };
  }
  return { blocked: false, reason: null, until: null };
}

export function usageView(now = Date.now()) {
  const accounts: UsageAccountView[] = listConnections()
    .filter((c) => c.authType === "oauth" && getProvider(c.provider)?.quota)
    .map((c) => {
      const snap = readSnapshot(c.id);
      const windows = snap?.windows || [];
      return {
        id: c.id,
        provider: c.provider,
        name: c.name,
        priority: c.priority,
        active: c.isActive,
        setupToken: !!c.data.setupToken,
        reauthRequired: !!c.data.reauthRequired,
        plan: snap?.plan || null,
        fetchedAt: snap?.fetchedAt || null,
        error: snap?.error || c.data.lastError || null,
        windows,
        guard: guardFor(c.provider, windows, now),
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.priority - b.priority);
  const t = usageTotals("24h");
  return {
    generatedAt: new Date(now).toISOString(),
    accounts,
    today: {
      requests: t?.requests || 0,
      errors: t?.errors || 0,
      promptTokens: t?.prompt || 0,
      completionTokens: t?.completion || 0,
      cachedTokens: t?.cached || 0,
      cost: t?.cost || 0,
      byProvider: usageSummary("24h", "provider").map((r) => ({ provider: r.key, requests: r.requests, cost: r.cost })),
    },
  };
}
