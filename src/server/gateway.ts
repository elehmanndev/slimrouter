// The request pipeline: resolve model -> expand combo -> pick account -> call upstream -> decode -> encode for client.
import { getProvider, PROVIDERS, type ProviderDef } from "./providers/registry";
import { expandCombo, getCombo } from "./combos";
import { ensureFresh, refreshConnection } from "./oauth";
import { markFailure, markSuccess, selectConnection } from "./router";
import { buildUpstream, type UpstreamSpec } from "./executors";
import { parseSse } from "./sse";
import { decodeClaudeEvent, decodeClaudeMessage, newClaudeDecodeState, type ClaudeRequest } from "./translate/claude";
import { decodeResponsesEvent, newResponsesDecodeState } from "./translate/responses";
import { decodeGeminiChunk, finishGemini, newGeminiDecodeState } from "./translate/gemini";
import { decodeOpenAIChunk, decodeOpenAICompletion } from "./translate/openai";
import type { ChatChunk, ChatRequest, Usage } from "./translate/types";
import type { Connection } from "./connections";
import { recordUsage } from "./usage";
import { costOf } from "./pricing";

export interface ResolvedTarget {
  provider: ProviderDef;
  model: string;
}

export class GatewayError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter: string | null = null,
  ) {
    super(message);
  }
}

/** "cc/claude-opus-5-5" -> { provider, model }. Bare names resolve through combos first, then by prefix guess. */
export function resolveTargets(requested: string): ResolvedTarget[] {
  const name = requested.replace(/\[1m\]$/, "");
  if (getCombo(name)) {
    const targets = expandCombo(name).map(parseTarget).filter((t): t is ResolvedTarget => !!t);
    if (!targets.length) throw new GatewayError(404, `Combo ${name} has no valid members`);
    return targets;
  }
  const direct = parseTarget(name);
  if (direct) return [direct];
  // Bare model id: find a provider that lists it, preferring OAuth ones.
  const candidates = Object.values(PROVIDERS).filter((p) => p.models.some((m) => m.id === name));
  const pick = candidates.find((p) => p.auth === "oauth") || candidates[0];
  if (pick) return [{ provider: pick, model: name }];
  if (/^claude-/.test(name)) return [{ provider: PROVIDERS.claude, model: name }];
  if (/^gpt-/.test(name)) return [{ provider: PROVIDERS.codex, model: name }];
  if (/^gemini-/.test(name)) return [{ provider: PROVIDERS.antigravity, model: name }];
  throw new GatewayError(404, `Unknown model: ${requested}`);
}

function parseTarget(s: string): ResolvedTarget | null {
  const i = s.indexOf("/");
  if (i <= 0) return null;
  const provider = getProvider(s.slice(0, i));
  if (!provider) return null;
  return { provider, model: s.slice(i + 1) };
}

export interface ExecuteOptions {
  req: ChatRequest;
  rawClaude: ClaudeRequest | null;
  clientHeaders: Headers;
  endpoint: string;
  apiKeyId: string | null;
  requestedModel: string;
  signal?: AbortSignal;
}

export interface ExecuteResult {
  provider: ProviderDef;
  model: string;
  connection: Connection;
  chunks: AsyncGenerator<ChatChunk>;
  toolNameMap?: Map<string, string>;
}

/** Try each target and, inside each, each account, until one streams a response. */
export async function execute(opts: ExecuteOptions): Promise<ExecuteResult> {
  const targets = resolveTargets(opts.requestedModel);
  let lastError: GatewayError | null = null;
  for (const target of targets) {
    try {
      return await executeTarget(target, opts);
    } catch (e) {
      lastError = e instanceof GatewayError ? e : new GatewayError(502, (e as Error).message);
      if (lastError.status >= 400 && lastError.status < 500 && lastError.status !== 429 && lastError.status !== 404 && targets.length === 1) throw lastError;
    }
  }
  throw lastError || new GatewayError(503, "No target available");
}

async function executeTarget(target: ResolvedTarget, opts: ExecuteOptions): Promise<ExecuteResult> {
  const exclude = new Set<string>();
  let last: { status: number; message: string } | null = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const sel = await selectConnection(target.provider.id, target.model, exclude);
    if (!sel.connection) {
      if (last) throw new GatewayError(last.status === 429 ? 429 : 503, `[${target.provider.alias}/${target.model}] ${last.message}`, sel.retryAfter);
      throw new GatewayError(503, `[${target.provider.alias}/${target.model}] ${sel.reason}`, sel.retryAfter);
    }
    const conn = await ensureFresh(sel.connection);
    const started = Date.now();
    const spec = buildUpstream(target.provider, conn, { ...opts.req, model: target.model }, opts.rawClaude, opts.clientHeaders);
    let res = await fetch(spec.url, { method: "POST", headers: spec.headers, body: JSON.stringify(spec.body), signal: opts.signal });
    if ((res.status === 401 || res.status === 403) && conn.authType === "oauth" && conn.data.refreshToken) {
      const refreshed = await refreshConnection(conn);
      if (refreshed) {
        const retrySpec = buildUpstream(target.provider, { ...conn, data: refreshed }, { ...opts.req, model: target.model }, opts.rawClaude, opts.clientHeaders);
        res = await fetch(retrySpec.url, { method: "POST", headers: retrySpec.headers, body: JSON.stringify(retrySpec.body), signal: opts.signal });
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = extractErrorMessage(text) || res.statusText || `HTTP ${res.status}`;
      const resetMs = upstreamResetMs(res, text);
      const verdict = markFailure(conn, target.model, res.status, message, resetMs);
      recordUsage({ provider: target.provider.id, model: target.model, requestedModel: opts.requestedModel, connectionId: conn.id, apiKeyId: opts.apiKeyId, endpoint: opts.endpoint, status: "error", httpStatus: res.status, usage: null, cost: 0, durationMs: Date.now() - started, error: message });
      last = { status: res.status, message };
      if (verdict.requestScoped) throw new GatewayError(res.status, message);
      exclude.add(conn.id);
      continue;
    }
    const chunks = decodeStream(res, spec, target.model, {
      onDone: (usage, error) => {
        if (!error) markSuccess(conn, target.model);
        recordUsage({ provider: target.provider.id, model: target.model, requestedModel: opts.requestedModel, connectionId: conn.id, apiKeyId: opts.apiKeyId, endpoint: opts.endpoint, status: error ? "error" : "ok", httpStatus: 200, usage, cost: costOf(target.model, usage), durationMs: Date.now() - started, error });
      },
    });
    return { provider: target.provider, model: target.model, connection: conn, chunks, toolNameMap: spec.toolNameMap };
  }
  throw new GatewayError(503, `[${target.provider.alias}/${target.model}] ${last?.message || "all accounts failed"}`);
}

function extractErrorMessage(text: string): string | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === "string") return j.error;
    return j.error?.message || j.message || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function upstreamResetMs(res: Response, text: string): number | null {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s) && s > 0) return Date.now() + s * 1000;
    const d = Date.parse(ra);
    if (Number.isFinite(d) && d > Date.now()) return d;
  }
  const reset = res.headers.get("anthropic-ratelimit-unified-reset") || res.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) {
    const n = Number(reset);
    const ms = n < 1e12 ? n * 1000 : n;
    if (ms > Date.now()) return ms;
  }
  const m = /"resets?_at"\s*:\s*"?(\d{10,13}|[0-9T:\-.Z+]+)"?/.exec(text);
  if (m) {
    const v = /^\d+$/.test(m[1]) ? Number(m[1]) * (m[1].length <= 10 ? 1000 : 1) : Date.parse(m[1]);
    if (Number.isFinite(v) && v > Date.now()) return v;
  }
  return null;
}

async function* decodeStream(res: Response, spec: UpstreamSpec, model: string, hooks: { onDone: (usage: Usage | null, error: string | null) => void }): AsyncGenerator<ChatChunk> {
  let usage: Usage | null = null;
  let error: string | null = null;
  const track = (chunks: ChatChunk[]) => {
    for (const c of chunks) if (c.usage) usage = c.usage;
    return chunks;
  };
  try {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/event-stream")) {
      const json = (await res.json()) as Record<string, unknown>;
      const chunks = spec.decode === "claude" ? decodeClaudeMessage(json) : spec.decode === "gemini" ? [...decodeGeminiChunk(json, newGeminiDecodeState(model))] : spec.decode === "openai" ? decodeOpenAICompletion(json, model) : decodeOpenAICompletion(json, model);
      for (const c of track(chunks)) yield c;
      return;
    }
    if (!res.body) throw new Error("empty upstream body");
    const claudeState = newClaudeDecodeState(model);
    const responsesState = newResponsesDecodeState(model);
    const geminiState = newGeminiDecodeState(model);
    let finished = false;
    for await (const rec of parseSse(res.body)) {
      if (rec.data === "[DONE]") break;
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(rec.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      let chunks: ChatChunk[];
      if (spec.decode === "claude") chunks = decodeClaudeEvent(rec.event ? { ...json, type: json.type || rec.event } : json, claudeState);
      else if (spec.decode === "responses") chunks = decodeResponsesEvent(json, responsesState);
      else if (spec.decode === "gemini") chunks = decodeGeminiChunk(json, geminiState);
      else chunks = decodeOpenAIChunk(json, model);
      for (const c of track(chunks)) {
        if (c.choices[0]?.finish_reason) finished = true;
        yield c;
      }
    }
    if (!finished) {
      const tail = spec.decode === "gemini" ? finishGemini(geminiState) : [];
      for (const c of track(tail)) yield c;
    }
  } catch (e) {
    error = (e as Error).message;
    throw e;
  } finally {
    hooks.onDone(usage, error);
  }
}
