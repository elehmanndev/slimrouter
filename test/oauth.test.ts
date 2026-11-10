import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "slimrouter-oauth-"));

const { defaultRedirectUri, startOAuth, oauthStatus } = await import("@/server/oauth");
const { PROVIDERS } = await import("@/server/providers/registry");

describe("oauth redirect uris", () => {
  it("sends Claude to localhost on the dashboard port, like 9router", () => {
    expect(defaultRedirectUri(PROVIDERS.claude, "http://192.168.1.45:20129")).toBe("http://localhost:20129/callback");
    expect(defaultRedirectUri(PROVIDERS.claude, "https://router.example.com")).toBe("http://localhost:443/callback");
  });

  it("keeps the fixed Codex redirect", () => {
    expect(defaultRedirectUri(PROVIDERS.codex, "http://192.168.1.45:20129")).toBe("http://localhost:1455/auth/callback");
  });

  it("uses the dashboard origin for Google flows", () => {
    expect(defaultRedirectUri(PROVIDERS.antigravity, "http://192.168.1.45:20129")).toBe("http://192.168.1.45:20129/oauth/callback");
  });

  it("builds a Claude authorize url with PKCE and a pollable state", () => {
    const r = startOAuth("claude", "http://192.168.1.45:20129");
    const u = new URL(r.authorizeUrl);
    expect(u.origin + u.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:20129/callback");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code")).toBe("true");
    expect(u.searchParams.get("state")).toBe(r.state);
    expect(oauthStatus(r.state).status).toBe("pending");
    expect(oauthStatus("nope").status).toBe("unknown");
  });
});
