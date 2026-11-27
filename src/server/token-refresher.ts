import { listConnections, type Connection } from "./connections";
import { getProvider } from "./providers/registry";
import { refreshConnection } from "./oauth";

/**
 * Background OAuth refresh, independent of traffic. A refresh token that is
 * never used can expire or be revoked upstream, so an idle account would
 * otherwise need a new sign-in. Every tick refreshes the connections whose
 * access token expires soon (or that the provider wants refreshed by age),
 * one at a time with a pause between them so upstreams never see a burst.
 */

export const BACKGROUND_LEAD_MS = 30 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_MS = 10 * 1000;
const PAUSE_MS = 1500;
const GOOGLE_PAUSE_MS = 12_000;
const GOOGLE = new Set(["antigravity", "gemini-cli"]);

export function dueForRefresh(connections: Connection[], now = Date.now()): Connection[] {
  return connections.filter((c) => {
    if (c.authType !== "oauth" || !c.isActive || !c.data.refreshToken || c.data.reauthRequired) return false;
    const o = getProvider(c.provider)?.oauth;
    if (!o) return false;
    const exp = c.data.expiresAt ? Date.parse(c.data.expiresAt) : NaN;
    if (Number.isFinite(exp) && exp - now < Math.max(o.refreshLeadMs, BACKGROUND_LEAD_MS)) return true;
    if (o.maxRefreshAgeMs) {
      const last = c.data.lastRefreshAt ? Date.parse(c.data.lastRefreshAt) : NaN;
      if (!Number.isFinite(last) || now - last >= o.maxRefreshAgeMs) return true;
    }
    return false;
  });
}

let running = false;

export async function runRefreshTick(deps: {
  load?: () => Connection[];
  refresh?: (c: Connection) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<number> {
  if (running) return 0;
  running = true;
  const load = deps.load ?? (() => listConnections());
  const refresh = deps.refresh ?? refreshConnection;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  let done = 0;
  try {
    const due = dueForRefresh(load());
    for (let i = 0; i < due.length; i++) {
      const c = due[i];
      try {
        if (await refresh(c)) done++;
        else console.warn(`[token-refresher] ${c.provider} ${c.name}: refresh failed, see the connection error`);
      } catch (e) {
        console.warn(`[token-refresher] ${c.provider} ${c.name}: ${(e as Error).message}`);
      }
      if (i < due.length - 1) await sleep(GOOGLE.has(c.provider) ? GOOGLE_PAUSE_MS + Math.floor(Math.random() * 4000) : PAUSE_MS);
    }
  } catch (e) {
    console.warn(`[token-refresher] tick failed: ${(e as Error).message}`);
  } finally {
    running = false;
  }
  return done;
}

const g = globalThis as typeof globalThis & { __slimTokenRefresher?: boolean };

export function startTokenRefresher() {
  if (g.__slimTokenRefresher || process.env.DISABLE_BACKGROUND_REFRESH === "1") return false;
  g.__slimTokenRefresher = true;
  const tick = () => void runRefreshTick();
  setTimeout(tick, FIRST_TICK_MS).unref?.();
  setInterval(tick, INTERVAL_MS).unref?.();
  return true;
}
