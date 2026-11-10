import { getDb, nowIso } from "./db";
import type { Usage } from "./translate/types";

export interface UsageRecord {
  provider: string;
  model: string;
  requestedModel: string | null;
  connectionId: string | null;
  apiKeyId: string | null;
  endpoint: string;
  status: "ok" | "error";
  httpStatus: number | null;
  usage: Usage | null;
  cost: number;
  durationMs: number;
  error?: string | null;
}

export function recordUsage(r: UsageRecord) {
  getDb()
    .prepare(
      `INSERT INTO usage (ts, provider, model, requested_model, connection_id, api_key_id, endpoint, status, http_status, prompt_tokens, completion_tokens, cached_tokens, cache_creation_tokens, cost, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nowIso(),
      r.provider,
      r.model,
      r.requestedModel,
      r.connectionId,
      r.apiKeyId,
      r.endpoint,
      r.status,
      r.httpStatus,
      r.usage?.prompt_tokens || 0,
      r.usage?.completion_tokens || 0,
      r.usage?.cached_tokens || 0,
      r.usage?.cache_creation_tokens || 0,
      r.cost,
      r.durationMs,
      r.error ? r.error.slice(0, 500) : null,
    );
}

export interface UsageSummaryRow {
  key: string;
  requests: number;
  errors: number;
  prompt: number;
  completion: number;
  cached: number;
  cost: number;
}

function since(range: string): string {
  const now = Date.now();
  const ms = range === "24h" ? 864e5 : range === "7d" ? 7 * 864e5 : range === "30d" ? 30 * 864e5 : 864e5;
  return new Date(now - ms).toISOString();
}

export function usageSummary(range: string, groupBy: "provider" | "model" | "connection_id" | "api_key_id"): UsageSummaryRow[] {
  const col = groupBy;
  return getDb()
    .prepare(
      `SELECT COALESCE(${col}, '') AS key, COUNT(*) AS requests, SUM(status = 'error') AS errors, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, SUM(cached_tokens) AS cached, SUM(cost) AS cost
       FROM usage WHERE ts >= ? GROUP BY ${col} ORDER BY cost DESC, requests DESC`,
    )
    .all(since(range)) as unknown as UsageSummaryRow[];
}

export function usageTotals(range: string) {
  return getDb()
    .prepare(`SELECT COUNT(*) AS requests, SUM(status = 'error') AS errors, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, SUM(cached_tokens) AS cached, SUM(cost) AS cost FROM usage WHERE ts >= ?`)
    .get(since(range)) as { requests: number; errors: number; prompt: number; completion: number; cached: number; cost: number };
}

export function usageSeries(range: string): { bucket: string; requests: number; cost: number; tokens: number }[] {
  const hourly = range === "24h";
  const fmt = hourly ? "%Y-%m-%dT%H:00" : "%Y-%m-%d";
  return getDb()
    .prepare(`SELECT strftime('${fmt}', ts) AS bucket, COUNT(*) AS requests, SUM(cost) AS cost, SUM(prompt_tokens + completion_tokens) AS tokens FROM usage WHERE ts >= ? GROUP BY bucket ORDER BY bucket`)
    .all(since(range)) as { bucket: string; requests: number; cost: number; tokens: number }[];
}

export function recentRequests(limit = 50) {
  return getDb()
    .prepare(`SELECT id, ts, provider, model, requested_model, connection_id, api_key_id, endpoint, status, http_status, prompt_tokens, completion_tokens, cached_tokens, cost, duration_ms, error FROM usage ORDER BY id DESC LIMIT ?`)
    .all(limit) as Record<string, unknown>[];
}

export function pruneUsage(days = 90) {
  getDb().prepare("DELETE FROM usage WHERE ts < ?").run(new Date(Date.now() - days * 864e5).toISOString());
}
