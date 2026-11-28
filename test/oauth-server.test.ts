import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "slimrouter-oauth-server-"));

const o = await import("@/server/mcp/oauth-server");
const { createApiKey, updateApiKey } = await import("@/server/apikeys");

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function authorizeQuery(clientId: string, redirect: string, challenge: string) {
  return new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st" });
}

describe("OAuth server for MCP connectors", () => {
  it("registers public clients with https or loopback redirects only", () => {
    expect(o.registerClient({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }).client_id).toBeTruthy();
    expect(o.registerClient({ redirect_uris: ["http://127.0.0.1:53280/callback"] }).client_id).toBeTruthy();
    expect(() => o.registerClient({ redirect_uris: ["http://evil.example/cb"] })).toThrow(/redirect/);
    expect(() => o.registerClient({ redirect_uris: ["https://x.test/cb"], token_endpoint_auth_method: "client_secret_basic" })).toThrow(/public/);
  });

  it("runs code + PKCE, binds the token to one key and rotates refresh tokens", () => {
    const redirect = "https://claude.ai/api/mcp/auth_callback";
    const { client_id } = o.registerClient({ client_name: "Claude", redirect_uris: [redirect] });
    const { verifier, challenge } = pkce();
    const ar = o.parseAuthorize(authorizeQuery(client_id, redirect, challenge));
    const key = createApiKey("connector", null, ["alpha"]).key;
    const back = new URL(o.approve(ar, { apiKeyId: key.id }));
    expect(back.searchParams.get("state")).toBe("st");
    const code = back.searchParams.get("code")!;

    // wrong verifier fails and burns the code
    expect(() => o.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id, code, redirect_uri: redirect, code_verifier: pkce().verifier }))).toThrow(/PKCE/);
    expect(() => o.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id, code, redirect_uri: redirect, code_verifier: verifier }))).toThrow(/invalid or expired/);

    const ar2 = o.parseAuthorize(authorizeQuery(client_id, redirect, challenge));
    const code2 = new URL(o.approve(ar2, { apiKeyId: key.id })).searchParams.get("code")!;
    const t = o.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id, code: code2, redirect_uri: redirect, code_verifier: verifier }));
    expect(o.keyForAccessToken(t.access_token)?.id).toBe(key.id);

    const t2 = o.exchange(new URLSearchParams({ grant_type: "refresh_token", client_id, refresh_token: t.refresh_token }));
    expect(o.keyForAccessToken(t2.access_token)?.id).toBe(key.id);
    expect(() => o.exchange(new URLSearchParams({ grant_type: "refresh_token", client_id, refresh_token: t.refresh_token }))).toThrow(/invalid or expired/);

    updateApiKey(key.id, { isActive: false });
    expect(o.keyForAccessToken(t2.access_token)).toBeNull();
  });

  it("refuses unregistered redirects and missing PKCE before redirecting", () => {
    const { client_id } = o.registerClient({ redirect_uris: ["https://a.test/cb"] });
    expect(() => o.parseAuthorize(authorizeQuery(client_id, "https://b.test/cb", pkce().challenge))).toThrow(/not registered/);
    const q = authorizeQuery(client_id, "https://a.test/cb", pkce().challenge);
    q.set("code_challenge_method", "plain");
    expect(() => o.parseAuthorize(q)).toThrow(/PKCE/);
  });

  it("can mint a dedicated key with chosen servers on approval", () => {
    const redirect = "http://localhost:3999/callback";
    const { client_id } = o.registerClient({ client_name: "Claude Desktop", redirect_uris: [redirect] });
    const { verifier, challenge } = pkce();
    const code = new URL(o.approve(o.parseAuthorize(authorizeQuery(client_id, redirect, challenge)), { newKeyName: "Desktop", allowedMcp: ["beta"] })).searchParams.get("code")!;
    const t = o.exchange(new URLSearchParams({ grant_type: "authorization_code", client_id, code, redirect_uri: redirect, code_verifier: verifier }));
    const k = o.keyForAccessToken(t.access_token)!;
    expect(k.name).toBe("Desktop");
    expect(k.allowedMcp).toEqual(["beta"]);
    expect(o.connectorSummary().some((c) => c.clientId === client_id)).toBe(true);
    o.revokeConnector(client_id);
    expect(o.keyForAccessToken(t.access_token)).toBeNull();
  });
});
