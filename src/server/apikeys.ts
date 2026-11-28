import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getDb, nowIso } from "./db";

export interface ApiKey {
  id: string;
  keyPrefix: string;
  name: string;
  isActive: boolean;
  allowedModels: string[] | null;
  // MCP servers this key may reach. null = none (keys made before MCP existed stay model-only), ["*"] = all.
  allowedMcp: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Row {
  id: string;
  key_hash: string;
  key_prefix: string;
  name: string;
  is_active: number;
  allowed_models: string | null;
  allowed_mcp: string | null;
  created_at: string;
  last_used_at: string | null;
}

const hash = (k: string) => createHash("sha256").update(k).digest("hex");

function rowToKey(r: Row): ApiKey {
  return {
    id: r.id,
    keyPrefix: r.key_prefix,
    name: r.name,
    isActive: r.is_active === 1,
    allowedModels: r.allowed_models ? (JSON.parse(r.allowed_models) as string[]) : null,
    allowedMcp: r.allowed_mcp ? (JSON.parse(r.allowed_mcp) as string[]) : null,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export function listApiKeys(): ApiKey[] {
  return (getDb().prepare("SELECT * FROM api_keys ORDER BY created_at ASC").all() as unknown as Row[]).map(rowToKey);
}

/** Creates a key and returns the plaintext once. */
export function createApiKey(name: string, allowedModels: string[] | null = null, allowedMcp: string[] | null = null): { key: ApiKey; plaintext: string } {
  const plaintext = `sk-slim-${randomBytes(24).toString("base64url")}`;
  const id = randomUUID();
  getDb()
    .prepare("INSERT INTO api_keys (id, key_hash, key_prefix, name, is_active, allowed_models, allowed_mcp, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)")
    .run(id, hash(plaintext), plaintext.slice(0, 12), name, allowedModels ? JSON.stringify(allowedModels) : null, allowedMcp ? JSON.stringify(allowedMcp) : null, nowIso());
  return { key: listApiKeys().find((k) => k.id === id)!, plaintext };
}

export function updateApiKey(id: string, patch: { name?: string; isActive?: boolean; allowedModels?: string[] | null; allowedMcp?: string[] | null }) {
  const current = (getDb().prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as unknown as Row | undefined);
  if (!current) return null;
  getDb()
    .prepare("UPDATE api_keys SET name = ?, is_active = ?, allowed_models = ?, allowed_mcp = ? WHERE id = ?")
    .run(
      patch.name ?? current.name,
      (patch.isActive ?? current.is_active === 1) ? 1 : 0,
      patch.allowedModels === undefined ? current.allowed_models : patch.allowedModels ? JSON.stringify(patch.allowedModels) : null,
      patch.allowedMcp === undefined ? current.allowed_mcp : patch.allowedMcp ? JSON.stringify(patch.allowedMcp) : null,
      id,
    );
  return rowToKey(getDb().prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as unknown as Row);
}

export function deleteApiKey(id: string) {
  getDb().prepare("DELETE FROM api_keys WHERE id = ?").run(id);
}

export function verifyApiKey(plaintext: string | null): ApiKey | null {
  if (!plaintext) return null;
  const row = getDb().prepare("SELECT * FROM api_keys WHERE key_hash = ? AND is_active = 1").get(hash(plaintext)) as unknown as Row | undefined;
  if (!row) return null;
  getDb().prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(nowIso(), row.id);
  return rowToKey(row);
}

export function extractBearer(headers: Headers, url: URL): string | null {
  const auth = headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return headers.get("x-api-key") || headers.get("x-goog-api-key") || url.searchParams.get("key");
}

/** Whether a key may reach an MCP server. */
export function keyAllowsMcp(key: ApiKey, server: string): boolean {
  const list = key.allowedMcp;
  return !!list && (list.includes("*") || list.includes(server));
}
