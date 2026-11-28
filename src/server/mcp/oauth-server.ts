import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb, nowIso } from "../db";
import { createApiKey, listApiKeys, type ApiKey } from "../apikeys";

/**
 * Minimal OAuth 2.1 authorization server so claude.ai and Claude Desktop can add slimrouter as a
 * custom connector, the way mcphub does today:
 *  - RFC 8414 / RFC 9728 discovery, RFC 7591 dynamic client registration (public clients only),
 *  - authorization code + PKCE S256, refresh tokens with rotation.
 * The person approving is the dashboard owner (dashboard login). An approval is bound to one
 * client key, so the connector gets exactly that key's MCP access and nothing else; access tokens
 * are opaque, stored hashed, and resolve to that key on every request.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 10;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, name TEXT, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_codes (code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, api_key_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, api_key_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_key ON oauth_tokens(api_key_id);
`;

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(SCHEMA);
    ready = true;
  }
  return d;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

export function metadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  };
}

export function resourceMetadata(issuer: string, resource: string) {
  return { resource, authorization_servers: [issuer], scopes_supported: ["mcp"], bearer_methods_supported: ["header"] };
}

function validRedirect(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    // Native apps (Claude Desktop, CLIs) use a loopback redirect on a random port.
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}

export function registerClient(body: unknown): { client_id: string; client_name: string | null; redirect_uris: string[] } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > MAX_REDIRECTS || !uris.every((u) => typeof u === "string" && validRedirect(u))) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be https or loopback http URLs");
  }
  const method = b.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") throw new OAuthError("invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are supported");
  const name = typeof b.client_name === "string" ? b.client_name.slice(0, 120) : null;
  const id = randomUUID();
  db().prepare("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").run(id, name, JSON.stringify(uris), nowIso());
  return { client_id: id, client_name: name, redirect_uris: uris as string[] };
}

export function getClient(id: string): { clientId: string; name: string | null; redirectUris: string[] } | null {
  const r = db().prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(id) as { client_id: string; name: string | null; redirect_uris: string } | undefined;
  return r ? { clientId: r.client_id, name: r.name, redirectUris: JSON.parse(r.redirect_uris) } : null;
}

export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  challenge: string;
  resource: string | null;
}

/** Validate the query of /oauth/authorize. Errors that make the redirect unsafe are thrown, not redirected. */
export function parseAuthorize(q: URLSearchParams): AuthorizeRequest {
  const client = getClient(q.get("client_id") || "");
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id");
  const redirectUri = q.get("redirect_uri") || "";
  if (!client.redirectUris.includes(redirectUri)) throw new OAuthError("invalid_request", "redirect_uri is not registered for this client");
  if (q.get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "response_type must be code");
  const challenge = q.get("code_challenge") || "";
  if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new OAuthError("invalid_request", "PKCE with S256 is required");
  return { clientId: client.clientId, redirectUri, state: q.get("state"), challenge, resource: q.get("resource") };
}

/** Owner approved: issue a code bound to one client key, or a new key made for this connector. */
export function approve(req: AuthorizeRequest, binding: { apiKeyId: string } | { newKeyName: string; allowedMcp: string[] }): string {
  let keyId: string;
  if ("apiKeyId" in binding) {
    if (!listApiKeys().some((k) => k.id === binding.apiKeyId && k.isActive)) throw new OAuthError("invalid_request", "Unknown or disabled key");
    keyId = binding.apiKeyId;
  } else {
    keyId = createApiKey(binding.newKeyName.slice(0, 80), null, binding.allowedMcp).key.id;
  }
  const code = token("slc_");
  db()
    .prepare("INSERT INTO oauth_codes (code_hash, client_id, api_key_id, redirect_uri, challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(sha(code), req.clientId, keyId, req.redirectUri, req.challenge, req.resource, Date.now() + CODE_TTL_MS);
  const u = new URL(req.redirectUri);
  u.searchParams.set("code", code);
  if (req.state) u.searchParams.set("state", req.state);
  return u.toString();
}

export function denyRedirect(req: AuthorizeRequest): string {
  const u = new URL(req.redirectUri);
  u.searchParams.set("error", "access_denied");
  if (req.state) u.searchParams.set("state", req.state);
  return u.toString();
}

function issueTokens(clientId: string, apiKeyId: string) {
  const access = token("sla_");
  const refresh = token("slr_");
  const now = Date.now();
  const ins = db().prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, api_key_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run(sha(access), "access", clientId, apiKeyId, now + ACCESS_TTL_S * 1000, nowIso());
  ins.run(sha(refresh), "refresh", clientId, apiKeyId, now + REFRESH_TTL_MS, nowIso());
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: "mcp" };
}

function pkceOk(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** POST /oauth/token for both grants. */
export function exchange(form: URLSearchParams) {
  const grant = form.get("grant_type");
  const clientId = form.get("client_id") || "";
  if (!getClient(clientId)) throw new OAuthError("invalid_client", "Unknown client_id", 401);
  const d = db();
  if (grant === "authorization_code") {
    const code = form.get("code") || "";
    const row = d.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha(code)) as
      | { client_id: string; api_key_id: string; redirect_uri: string; challenge: string; expires_at: number }
      | undefined;
    // Codes are single use whatever happens next.
    d.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(sha(code));
    if (!row || row.expires_at < Date.now() || row.client_id !== clientId) throw new OAuthError("invalid_grant", "Code is invalid or expired");
    if (form.get("redirect_uri") !== row.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri does not match");
    if (!pkceOk(form.get("code_verifier") || "", row.challenge)) throw new OAuthError("invalid_grant", "PKCE verification failed");
    return issueTokens(clientId, row.api_key_id);
  }
  if (grant === "refresh_token") {
    const rt = form.get("refresh_token") || "";
    const row = d.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(sha(rt)) as { client_id: string; api_key_id: string; expires_at: number } | undefined;
    d.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run(sha(rt));
    if (!row || row.expires_at < Date.now() || row.client_id !== clientId) throw new OAuthError("invalid_grant", "Refresh token is invalid or expired");
    return issueTokens(clientId, row.api_key_id);
  }
  throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

export function revoke(form: URLSearchParams) {
  const t = form.get("token");
  if (t) db().prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run(sha(t));
}

/** Resolve an OAuth access token to the client key it was approved for. */
export function keyForAccessToken(bearer: string | null): ApiKey | null {
  if (!bearer?.startsWith("sla_")) return null;
  const row = db().prepare("SELECT api_key_id, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(sha(bearer)) as { api_key_id: string; expires_at: number } | undefined;
  if (!row || row.expires_at < Date.now()) return null;
  return listApiKeys().find((k) => k.id === row.api_key_id && k.isActive) ?? null;
}

export function connectorSummary() {
  return db()
    .prepare(
      `SELECT c.client_id AS clientId, c.name, t.api_key_id AS apiKeyId, MAX(t.created_at) AS lastIssued FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
       WHERE t.kind = 'refresh' AND t.expires_at > ? GROUP BY c.client_id, t.api_key_id ORDER BY lastIssued DESC`,
    )
    .all(Date.now()) as unknown as { clientId: string; name: string | null; apiKeyId: string; lastIssued: string }[];
}

export function revokeConnector(clientId: string) {
  db().prepare("DELETE FROM oauth_tokens WHERE client_id = ?").run(clientId);
}

export function pruneOAuth() {
  const now = Date.now();
  db().prepare("DELETE FROM oauth_codes WHERE expires_at < ?").run(now);
  db().prepare("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now);
}
