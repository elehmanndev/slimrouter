import { getDb, nowIso } from "./db";
import { getProvider, ANTIGRAVITY_BASE_URL, ANTIGRAVITY_IDE_VERSION, ANTIGRAVITY_USER_AGENT, CLAUDE_CLI_VERSION } from "./providers/registry";
import { ensureFresh, type Connection } from "./connections-bridge";
import { getSettings } from "./settings";

export interface QuotaWindow {
  key: "session" | "weekly" | string;
  label: string;
  usedPercent: number; // 0..100
  remainingPercent: number;
  resetAt: string | null;
}

export interface QuotaSnapshot {
  connectionId: string;
  fetchedAt: string;
  plan: string | null;
  windows: QuotaWindow[];
  error: string | null;
}

function pct(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function iso(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) return iso(Number(v));
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return null;
}

async function claudeQuota(token: string): Promise<Omit<QuotaSnapshot, "connectionId" | "fetchedAt">> {
  const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "user-agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
    },
  });
  if (!r.ok) return { plan: null, windows: [], error: `usage endpoint ${r.status}` };
  const d = (await r.json()) as Record<string, { utilization?: number; resets_at?: string } | unknown>;
  const windows: QuotaWindow[] = [];
  const add = (key: string, label: string, w: unknown) => {
    const win = w as { utilization?: number; resets_at?: string } | undefined;
    if (!win || typeof win.utilization !== "number") return;
    const used = pct(win.utilization);
    windows.push({ key, label, usedPercent: used, remainingPercent: 100 - used, resetAt: iso(win.resets_at) });
  };
  add("session", "Session (5h)", d.five_hour);
  add("weekly", "Weekly (7d)", d.seven_day);
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith("seven_day_") && k !== "seven_day") add(`weekly_${k.slice(10)}`, `Weekly ${k.slice(10)} (7d)`, v);
  }
  const limits = (d.limits as { kind?: string; percent?: number; resets_at?: string; scope?: { model?: { display_name?: string } } }[]) || [];
  for (const l of Array.isArray(limits) ? limits : []) {
    if (l?.kind !== "weekly_scoped" || typeof l.percent !== "number") continue;
    const name = (l.scope?.model?.display_name || "model").toLowerCase();
    add(`weekly_${name}`, `Weekly ${name} (7d)`, { utilization: l.percent, resets_at: l.resets_at });
  }
  return { plan: "Claude", windows, error: null };
}

async function codexQuota(token: string): Promise<Omit<QuotaSnapshot, "connectionId" | "fetchedAt">> {
  const r = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!r.ok) return { plan: null, windows: [], error: `usage endpoint ${r.status}` };
  const d = (await r.json()) as Record<string, unknown>;
  const rl = (d.rate_limit || d.rate_limits || (d.rate_limits_by_limit_id as Record<string, unknown>)?.codex || {}) as Record<string, unknown>;
  const body = (rl.rate_limit as Record<string, unknown>) || rl;
  const primary = (body.primary_window || body.primary) as { used_percent?: number; percent_used?: number; reset_at?: unknown; resets_at?: unknown } | undefined;
  const secondary = (body.secondary_window || body.secondary) as typeof primary;
  const windows: QuotaWindow[] = [];
  if (primary) {
    const used = pct(primary.used_percent ?? primary.percent_used);
    windows.push({ key: "session", label: "Session (5h)", usedPercent: used, remainingPercent: 100 - used, resetAt: iso(primary.reset_at ?? primary.resets_at) });
  }
  if (secondary) {
    const used = pct(secondary.used_percent ?? secondary.percent_used);
    windows.push({ key: "weekly", label: "Weekly (7d)", usedPercent: used, remainingPercent: 100 - used, resetAt: iso(secondary.reset_at ?? secondary.resets_at) });
  }
  return { plan: (d.plan_type as string) || null, windows, error: null };
}

async function antigravityQuota(token: string, projectId: string | null): Promise<Omit<QuotaSnapshot, "connectionId" | "fetchedAt">> {
  const r = await fetch(`${ANTIGRAVITY_BASE_URL}/v1internal:retrieveUserQuotaSummary`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": ANTIGRAVITY_USER_AGENT,
      "content-type": "application/json",
      "x-client-name": "antigravity",
      "x-client-version": ANTIGRAVITY_IDE_VERSION,
    },
    body: JSON.stringify(projectId ? { project: projectId } : {}),
  });
  if (!r.ok) return { plan: null, windows: [], error: `quota summary ${r.status}` };
  const d = (await r.json()) as { groups?: unknown[]; quotaSummary?: { groups?: unknown[] } };
  const groups = (d.groups || d.quotaSummary?.groups || []) as {
    displayName?: string;
    buckets?: { window?: string; bucketId?: string; displayName?: string; remainingFraction?: number; resetTime?: string; disabled?: boolean }[];
  }[];
  const windows: QuotaWindow[] = [];
  for (const g of groups) {
    const family = /argon/i.test(g.displayName || "") ? "argon" : /gemini/i.test(g.displayName || "") ? "gemini" : /claude|gpt/i.test(g.displayName || "") ? "claude_gpt" : null;
    if (!family) continue;
    for (const b of g.buckets || []) {
      const text = `${b.window || ""} ${b.bucketId || ""} ${b.displayName || ""}`.toLowerCase();
      const weekly = text.includes("weekly");
      const session = /5h|five hour|daily/.test(text);
      if (!weekly && !session) continue;
      if (b.disabled && weekly) continue;
      const frac = b.disabled ? 0 : Number(b.remainingFraction);
      if (!Number.isFinite(frac)) continue;
      const key = `${family}_${weekly ? "weekly" : "session"}`;
      if (windows.some((w) => w.key === key)) continue;
      const remaining = pct(frac * 100);
      windows.push({ key, label: `${g.displayName || family} ${weekly ? "(Weekly)" : "(5h)"}`, usedPercent: 100 - remaining, remainingPercent: remaining, resetAt: iso(b.resetTime) });
    }
  }
  return { plan: null, windows, error: null };
}

export function readSnapshot(connectionId: string): QuotaSnapshot | null {
  const row = getDb().prepare("SELECT data FROM quota_snapshots WHERE connection_id = ?").get(connectionId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as QuotaSnapshot) : null;
}

const inFlight = new Map<string, Promise<QuotaSnapshot | null>>();

export async function fetchQuota(c: Connection, force = false): Promise<QuotaSnapshot | null> {
  const provider = getProvider(c.provider);
  if (!provider?.quota || c.authType !== "oauth") return null;
  const ttl = getSettings().quotaRefreshSec * 1000;
  const cached = readSnapshot(c.id);
  if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < ttl) return cached;
  const existing = inFlight.get(c.id);
  if (existing) return existing;
  const task = (async () => {
    try {
      const fresh = await ensureFresh(c);
      const token = fresh.data.accessToken;
      if (!token) throw new Error("no access token");
      const partial =
        provider.quota === "claude"
          ? await claudeQuota(token)
          : provider.quota === "codex"
            ? await codexQuota(token)
            : await antigravityQuota(token, fresh.data.projectId || null);
      // Keep the last good read when upstream fails transiently.
      const snap: QuotaSnapshot = partial.error && cached ? { ...cached, error: partial.error, fetchedAt: nowIso() } : { connectionId: c.id, fetchedAt: nowIso(), ...partial };
      getDb()
        .prepare("INSERT INTO quota_snapshots (connection_id, fetched_at, data) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET fetched_at = excluded.fetched_at, data = excluded.data")
        .run(c.id, snap.fetchedAt, JSON.stringify(snap));
      return snap;
    } catch (e) {
      const snap: QuotaSnapshot = { connectionId: c.id, fetchedAt: nowIso(), plan: cached?.plan || null, windows: cached?.windows || [], error: (e as Error).message };
      return snap;
    } finally {
      inFlight.delete(c.id);
    }
  })();
  inFlight.set(c.id, task);
  return task;
}

/** Window used by the guard for a provider: the generic session/weekly windows, or the family windows for Antigravity. */
export function guardWindows(snapshot: QuotaSnapshot | null, model: string | null): { session: QuotaWindow | null; weekly: QuotaWindow | null } {
  if (!snapshot) return { session: null, weekly: null };
  const byKey = (k: string) => snapshot.windows.find((w) => w.key === k) || null;
  const generic = { session: byKey("session"), weekly: byKey("weekly") };
  if (generic.session || generic.weekly) return generic;
  // Antigravity family windows
  const m = (model || "").toLowerCase();
  const family = m.includes("argon") ? "argon" : m.startsWith("claude") || m.startsWith("gpt") ? "claude_gpt" : "gemini";
  return { session: byKey(`${family}_session`), weekly: byKey(`${family}_weekly`) };
}
