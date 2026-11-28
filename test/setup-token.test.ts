import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "slimrouter-setup-token-"));

const { normalizeSetupToken, addClaudeSetupToken } = await import("@/server/setup-token");
const { windowsFromUnifiedHeaders } = await import("@/server/quota");
const { listConnections } = await import("@/server/connections");
const { dueForRefresh } = await import("@/server/token-refresher");

const TOKEN = "sk-ant-oat01-" + "a".repeat(80);
const reset = Math.floor(Date.now() / 1000) + 3600;

function okHeaders(extra: Record<string, string> = {}) {
  return new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-5h-reset": String(reset),
    "anthropic-ratelimit-unified-7d-utilization": "0.6",
    "anthropic-ratelimit-unified-7d-reset": String(reset + 86400),
    ...extra,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("setup tokens", () => {
  it("accepts only the token claude setup-token prints", () => {
    expect(normalizeSetupToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(() => normalizeSetupToken("sk-ant-ort01-" + "a".repeat(80))).toThrow(/refresh token/);
    expect(() => normalizeSetupToken("sk-ant-api03-" + "a".repeat(80))).toThrow(/API key/);
    expect(() => normalizeSetupToken("hello")).toThrow(/Not a setup-token/);
  });

  it("reads the 5h and weekly windows from the unified rate-limit headers", () => {
    const w = windowsFromUnifiedHeaders(okHeaders());
    expect(w.map((x) => [x.key, x.usedPercent, x.remainingPercent])).toEqual([
      ["session", 25, 75],
      ["weekly", 60, 40],
    ]);
    expect(w[0].resetAt).toBe(new Date(reset * 1000).toISOString());
    expect(windowsFromUnifiedHeaders(new Headers({ "anthropic-ratelimit-unified-5h-utilization": "nope" }))).toEqual([]);
  });

  it("verifies the token, stores it for a year and keeps it out of the refresher", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: okHeaders() })));
    const r = await addClaudeSetupToken(TOKEN, "Calidad");
    expect(r.replaced).toBe(false);
    const c = listConnections({ provider: "claude" }).find((x) => x.name === "Calidad")!;
    expect(c.data.setupToken).toBe(true);
    expect(c.data.refreshToken).toBeUndefined();
    expect(Date.parse(c.data.expiresAt!) - Date.now()).toBeGreaterThan(364 * 86400e3);
    expect(dueForRefresh([c])).toEqual([]);
    expect(JSON.stringify(r.connection)).not.toContain(TOKEN);
  });

  it("replaces the token when pasted again under the same name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: okHeaders() })));
    const r = await addClaudeSetupToken("sk-ant-oat01-" + "b".repeat(80), "Calidad");
    expect(r.replaced).toBe(true);
    expect(listConnections({ provider: "claude" }).filter((x) => x.name === "Calidad")).toHaveLength(1);
  });

  it("treats a rejected 429 as a valid reading with the limit spent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 429, headers: okHeaders({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(reset) }) })));
    const r = await addClaudeSetupToken("sk-ant-oat01-" + "c".repeat(80), "Automatizaciones");
    expect(r.replaced).toBe(false);
  });

  it("refuses a token Anthropic rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(addClaudeSetupToken("sk-ant-oat01-" + "d".repeat(80), "Bad")).rejects.toThrow(/rejected this token/);
    expect(listConnections({ provider: "claude" }).some((x) => x.name === "Bad")).toBe(false);
  });
});

describe("usage view for client keys", () => {
  it("lists accounts with windows and guard state, without tokens", async () => {
    const { usageView } = await import("@/server/usage-api");
    const { getDb } = await import("@/server/db");
    const c = listConnections({ provider: "claude" }).find((x) => x.name === "Calidad")!;
    const snap = { connectionId: c.id, fetchedAt: new Date().toISOString(), plan: "Claude (setup token)", error: null, windows: [{ key: "session", label: "Session (5h)", usedPercent: 95, remainingPercent: 5, resetAt: new Date(Date.now() + 3600e3).toISOString() }] };
    getDb().prepare("INSERT OR REPLACE INTO quota_snapshots (connection_id, fetched_at, data) VALUES (?, ?, ?)").run(c.id, snap.fetchedAt, JSON.stringify(snap));
    const v = usageView();
    const row = v.accounts.find((a) => a.id === c.id)!;
    expect(row.setupToken).toBe(true);
    expect(row.guard.blocked).toBe(true);
    expect(row.guard.reason).toContain("5h");
    expect(JSON.stringify(v)).not.toMatch(/sk-ant-/);
    expect(v.today).toHaveProperty("requests");
  });
});
