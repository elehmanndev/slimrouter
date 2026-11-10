import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "slimrouter-test-"));

const mods = await Promise.all([import("@/server/connections"), import("@/server/router"), import("@/server/settings"), import("@/server/db"), import("@/server/combos"), import("@/server/apikeys")]);
const [connections, router, settings, db, combos, apikeys] = mods;

describe("account selection", () => {
  let a: string;
  let b: string;
  beforeAll(() => {
    a = connections.createConnection({ provider: "codex", authType: "oauth", name: "A", data: { accessToken: "x" } }).id;
    b = connections.createConnection({ provider: "codex", authType: "oauth", name: "B", data: { accessToken: "y" } }).id;
  });

  it("fill-first always picks the top priority account", async () => {
    settings.saveSettings({ providerStrategies: { codex: { strategy: "fill-first", stickyLimit: 1, minRemainingSessionPercent: 10, minRemainingWeeklyPercent: 10 } } });
    const first = await router.selectConnection("codex", "gpt-6-sol", new Set());
    const second = await router.selectConnection("codex", "gpt-6-sol", new Set());
    expect(first.connection?.id).toBe(a);
    expect(second.connection?.id).toBe(a);
  });

  it("round-robin with sticky 1 alternates, sticky 2 repeats once", async () => {
    settings.saveSettings({ providerStrategies: { codex: { strategy: "round-robin", stickyLimit: 1, minRemainingSessionPercent: 10, minRemainingWeeklyPercent: 10 } } });
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) picks.push((await router.selectConnection("codex", "m", new Set())).connection!.id);
    expect(picks[0]).not.toBe(picks[1]);
    expect(picks[0]).toBe(picks[2]);
    settings.saveSettings({ providerStrategies: { codex: { strategy: "round-robin", stickyLimit: 2, minRemainingSessionPercent: 10, minRemainingWeeklyPercent: 10 } } });
    for (const id of [a, b]) connections.patchConnectionData(id, { lastUsedAt: null, consecutiveUseCount: 0 });
    const sticky: string[] = [];
    for (let i = 0; i < 4; i++) sticky.push((await router.selectConnection("codex", "m", new Set())).connection!.id);
    expect(sticky[0]).toBe(sticky[1]);
    expect(sticky[1]).not.toBe(sticky[2]);
    expect(sticky[2]).toBe(sticky[3]);
  });

  it("skips an account below the quota threshold and reports when it resets", async () => {
    settings.saveSettings({ providerStrategies: { codex: { strategy: "fill-first", stickyLimit: 1, minRemainingSessionPercent: 10, minRemainingWeeklyPercent: 20 } } });
    const resetAt = new Date(Date.now() + 3600e3).toISOString();
    const snap = { connectionId: a, fetchedAt: new Date().toISOString(), plan: "plus", error: null, windows: [{ key: "session", label: "s", usedPercent: 50, remainingPercent: 50, resetAt }, { key: "weekly", label: "w", usedPercent: 85, remainingPercent: 15, resetAt }] };
    db.getDb().prepare("INSERT OR REPLACE INTO quota_snapshots (connection_id, fetched_at, data) VALUES (?, ?, ?)").run(a, snap.fetchedAt, JSON.stringify(snap));
    const pick = await router.selectConnection("codex", "m", new Set());
    expect(pick.connection?.id).toBe(b);
    connections.updateConnection(b, { isActive: false });
    const none = await router.selectConnection("codex", "m", new Set());
    expect(none.connection).toBeNull();
    expect(none.reason).toContain("weekly");
    expect(none.retryAfter).toBe(resetAt);
    connections.updateConnection(b, { isActive: true });
    db.getDb().prepare("DELETE FROM quota_snapshots WHERE connection_id = ?").run(a);
  });

  it("locks a model after a 429 and clears it on success", async () => {
    const conn = connections.getConnection(a)!;
    const verdict = router.markFailure(conn, "m", 429, "rate limit exceeded");
    expect(verdict.fallback).toBe(true);
    expect(connections.getConnection(a)!.data.modelLocks?.m).toBeTruthy();
    const pick = await router.selectConnection("codex", "m", new Set());
    expect(pick.connection?.id).toBe(b);
    const other = await router.selectConnection("codex", "other-model", new Set());
    expect(other.connection?.id).toBe(a);
    router.markSuccess(connections.getConnection(a)!, "m");
    expect(connections.getConnection(a)!.data.modelLocks?.m).toBeUndefined();
  });

  it("does not punish the account for a request-scoped 400", () => {
    const verdict = router.classifyFailure(400, "invalid schema", 0);
    expect(verdict.requestScoped).toBe(true);
    expect(verdict.fallback).toBe(false);
  });
});

describe("combos and keys", () => {
  it("expands nested combos and rotates round-robin ones", () => {
    combos.upsertCombo({ name: "inner", models: ["cx/gpt-6-sol"] });
    combos.upsertCombo({ name: "outer", models: ["cc/claude-opus-5-5", "inner"], strategy: "round-robin" });
    expect(combos.expandCombo("outer")).toEqual(["cc/claude-opus-5-5", "cx/gpt-6-sol"]);
    expect(combos.expandCombo("outer")).toEqual(["cx/gpt-6-sol", "cc/claude-opus-5-5"]);
  });

  it("verifies only the plaintext key and never stores it", () => {
    const { plaintext, key } = apikeys.createApiKey("test");
    expect(plaintext.startsWith("sk-slim-")).toBe(true);
    expect(apikeys.verifyApiKey(plaintext)?.id).toBe(key.id);
    expect(apikeys.verifyApiKey("sk-slim-nope")).toBeNull();
    const row = db.getDb().prepare("SELECT key_hash FROM api_keys WHERE id = ?").get(key.id) as { key_hash: string };
    expect(row.key_hash).not.toContain(plaintext.slice(8));
  });
});
