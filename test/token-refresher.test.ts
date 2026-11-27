import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "slimrouter-refresher-"));

const { dueForRefresh, runRefreshTick } = await import("@/server/token-refresher");
import type { Connection, ConnectionData } from "@/server/connections";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const H = 60 * 60 * 1000;

function conn(id: string, provider: string, data: ConnectionData, extra: Partial<Connection> = {}): Connection {
  return { id, provider, authType: "oauth", name: id, email: null, priority: 1, isActive: true, data, createdAt: "", updatedAt: "", ...extra } as Connection;
}

describe("background token refresh", () => {
  it("picks idle accounts whose token expires soon or already expired", () => {
    const list = [
      conn("expired", "claude", { refreshToken: "r", expiresAt: iso(-16 * 24 * H), lastRefreshAt: iso(-17 * 24 * H) }),
      conn("soon", "claude", { refreshToken: "r", expiresAt: iso(10 * 60 * 1000), lastRefreshAt: iso(-H) }),
      conn("fresh", "codex", { refreshToken: "r", expiresAt: iso(5 * 24 * H), lastRefreshAt: iso(-H) }),
    ];
    expect(dueForRefresh(list, NOW).map((c) => c.id)).toEqual(["expired", "soon"]);
  });

  it("refreshes Claude ahead of the 4 hour on-request lead, not only 30 minutes", () => {
    const c = conn("c", "claude", { refreshToken: "r", expiresAt: iso(3 * H), lastRefreshAt: iso(-5 * H) });
    expect(dueForRefresh([c], NOW)).toHaveLength(1);
  });

  it("refreshes Codex by age so an unused refresh token never goes stale", () => {
    const c = conn("cx", "codex", { refreshToken: "r", expiresAt: iso(9 * 24 * H), lastRefreshAt: iso(-8 * 24 * H) });
    expect(dueForRefresh([c], NOW)).toHaveLength(1);
  });

  it("skips API keys, disabled accounts, missing refresh tokens and accounts that need a new sign-in", () => {
    const old = { refreshToken: "r", expiresAt: iso(-H) };
    const list = [
      conn("key", "anthropic", old, { authType: "apikey" }),
      conn("off", "claude", old, { isActive: false }),
      conn("norefresh", "claude", { expiresAt: iso(-H) }),
      conn("dead", "claude", { ...old, reauthRequired: true }),
    ];
    expect(dueForRefresh(list, NOW)).toEqual([]);
  });

  it("refreshes one at a time, pauses between accounts and survives a failure", async () => {
    const order: string[] = [];
    const pauses: number[] = [];
    const list = [
      conn("a", "claude", { refreshToken: "r", expiresAt: iso(-H) }),
      conn("b", "claude", { refreshToken: "r", expiresAt: iso(-H) }),
      conn("c", "claude", { refreshToken: "r", expiresAt: iso(-H) }),
    ];
    const done = await runRefreshTick({
      load: () => list,
      refresh: async (c) => {
        order.push(c.id);
        if (c.id === "b") throw new Error("boom");
        return {};
      },
      sleep: async (ms) => void pauses.push(ms),
    });
    expect(order).toEqual(["a", "b", "c"]);
    expect(done).toBe(2);
    expect(pauses).toEqual([1500, 1500]);
  });
});
