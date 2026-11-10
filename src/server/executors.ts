// Per-provider upstream request builders. Each executor takes the internal chat request and
// returns a fetch spec; the response is decoded into internal chunks by the matching decoder.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ANTHROPIC_BETA_BASE, ANTHROPIC_BETA_EFFORT, CLAUDE_CLI_VERSION, type ProviderDef, upstreamModelId } from "./providers/registry";
import type { Connection } from "./connections";
import { chatToClaude, type ClaudeRequest } from "./translate/claude";
import { chatToResponses } from "./translate/responses";
import { chatToGemini } from "./translate/gemini";
import { stripForUpstream } from "./translate/openai";
import type { ChatRequest } from "./translate/types";

export interface UpstreamSpec {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  streaming: boolean; // whether we asked upstream for SSE
  decode: "claude" | "responses" | "gemini" | "openai";
  toolNameMap?: Map<string, string>; // cloaked -> original
}

const CLAUDE_TOOL_SUFFIX = "_ide";
const CC_DECOY_NAMES = ["Task", "TaskOutput", "TaskStop", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "AskUserQuestion", "Skill", "EnterPlanMode", "ExitPlanMode"];
const CC_DECOYS = CC_DECOY_NAMES.map((name) => ({ name, description: "This tool is currently unavailable.", input_schema: { type: "object", properties: {} } }));

const CODEX_DEFAULT_INSTRUCTIONS = "You are Codex, a coding agent running in the Codex CLI. Follow the user's instructions carefully, prefer concise answers, and use the available tools when they help complete the task.";

function sessionIdFor(c: Connection, req: ChatRequest): string {
  const meta = req.metadata as { user_id?: string } | undefined;
  const seed = meta?.user_id || `${c.id}:${(req.messages.find((m) => m.role !== "system")?.content as string) ?? ""}`.slice(0, 200);
  const h = createHash("sha256").update(String(seed)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function anthropicBeta(model: string, clientBeta: string | null): string {
  const flags = new Set(ANTHROPIC_BETA_BASE);
  if (/^claude-(opus|sonnet)/.test(model)) for (const f of ANTHROPIC_BETA_EFFORT) flags.add(f);
  for (const f of (clientBeta || "").split(",").map((s) => s.trim()).filter(Boolean)) if (!/^claude-code-/.test(f)) flags.add(f);
  return [...flags].join(",");
}

/** Claude Code OAuth: tool cloaking plus the Claude Code identity so the subscription accepts the request. */
function buildClaude(provider: ProviderDef, c: Connection, req: ChatRequest, raw: ClaudeRequest | null, clientHeaders: Headers): UpstreamSpec {
  const model = upstreamModelId(provider, req.model);
  const body: ClaudeRequest = raw ? { ...raw, model } : { ...chatToClaude({ ...req, model }), model };
  delete body.stream;
  body.stream = true;
  const oauth = c.authType === "oauth";
  let toolNameMap: Map<string, string> | undefined;
  if (oauth) {
    if (Array.isArray(body.tools) && body.tools.length) {
      toolNameMap = new Map();
      const client = body.tools.map((t) => {
        if (t.type) return t;
        const suffixed = `${t.name}${CLAUDE_TOOL_SUFFIX}`;
        toolNameMap!.set(suffixed, t.name);
        return { ...t, name: suffixed };
      });
      const clientNames = new Set(body.tools.filter((t) => !t.type).map((t) => t.name));
      body.tools = [...client, ...CC_DECOYS.filter((d) => !clientNames.has(d.name))];
      body.messages = body.messages.map((m) =>
        Array.isArray(m.content) ? { ...m, content: m.content.map((b) => (b.type === "tool_use" && clientNames.has(b.name) ? { ...b, name: `${b.name}${CLAUDE_TOOL_SUFFIX}` } : b)) } : m,
      );
      if (body.tool_choice?.type === "tool" && body.tool_choice.name && clientNames.has(body.tool_choice.name)) body.tool_choice = { ...body.tool_choice, name: `${body.tool_choice.name}${CLAUDE_TOOL_SUFFIX}` };
    }
    const sessionId = sessionIdFor(c, req);
    const billing = `x-anthropic-billing-header: cc_version=${CLAUDE_CLI_VERSION}.${randomBytes(2).toString("hex").slice(0, 3)}; cc_entrypoint=sdk-cli; cch=${createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 5)};`;
    const sys = Array.isArray(body.system) ? body.system : typeof body.system === "string" ? [{ type: "text" as const, text: body.system }] : [];
    if (!sys[0]?.text?.startsWith("x-anthropic-billing-header:")) body.system = [{ type: "text", text: billing }, ...sys];
    if (!body.metadata?.user_id) {
      const deviceId = createHash("sha256").update(`device:${c.id}`).digest("hex");
      body.metadata = { ...(body.metadata || {}), user_id: JSON.stringify({ device_id: deviceId, account_uuid: sessionIdFor(c, { ...req, metadata: { user_id: `account:${c.id}` } }), session_id: sessionId }) };
    }
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    ...(provider.headers || {}),
    "anthropic-beta": oauth ? anthropicBeta(model, clientHeaders.get("anthropic-beta")) : "interleaved-thinking-2025-05-14",
  };
  if (oauth) {
    headers.authorization = `Bearer ${c.data.accessToken}`;
    headers["x-claude-code-session-id"] = sessionIdFor(c, req);
  } else headers["x-api-key"] = c.data.apiKey || "";
  return { url: provider.baseUrl, headers, body, streaming: true, decode: "claude", toolNameMap };
}

function buildCodex(provider: ProviderDef, c: Connection, req: ChatRequest): UpstreamSpec {
  const model = upstreamModelId(provider, req.model);
  const body = chatToResponses({ ...req, model });
  body.model = model;
  body.stream = true;
  body.store = false;
  if (!body.instructions) body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
  const session = sessionIdFor(c, req);
  body.prompt_cache_key = session;
  body.reasoning = { effort: normalizeCodexEffort(req.reasoning_effort || "medium"), summary: "auto" };
  body.include = ["reasoning.encrypted_content"];
  body.text = { verbosity: "medium" };
  // Codex rejects fields outside its allowlist.
  const allow = new Set(["model", "input", "instructions", "tools", "tool_choice", "stream", "store", "reasoning", "include", "prompt_cache_key", "text", "parallel_tool_calls", "max_output_tokens"]);
  for (const k of Object.keys(body)) if (!allow.has(k)) delete (body as Record<string, unknown>)[k];
  delete (body as Record<string, unknown>).max_output_tokens;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${c.data.accessToken}`,
    session_id: session,
    ...(provider.headers || {}),
  };
  if (c.data.accountId) headers["chatgpt-account-id"] = c.data.accountId;
  return { url: provider.baseUrl, headers, body, streaming: true, decode: "responses" };
}

function normalizeCodexEffort(e: string): string {
  if (e === "none" || e === "minimal") return "low";
  if (e === "max") return "xhigh";
  return ["low", "medium", "high", "xhigh"].includes(e) ? e : "medium";
}

const AG_SIGNATURE = "EuwGCukGAXLI2nxwZIq54WWSoL/YN0P3TsDZ7zRnLi8g0S4aVr2HUGxvaHKySuY6HAVzcE0GPGjXrytLIldxthSvfxgUlJh6Qa9Z+Oj5QZBlYdg6HaJ6yuY5R7waE6rdwBsRf7Ft2j3DJ9rMi9qhWFqApewYtPhls3VHtuvND3l8Rm09+lbAXQs6KKWEWrxNLKTBkfpMgXhRERc/TQRMZu1twAablm6/Zk1tsYRvfWKLsNbeKF+CCojJdXJKvnR/8Ouuoa+Y2Ti20hcW7aZIIjZDFYPU//k6Ybmhg69J/imbFai2ckhfLaisqdDkdoIiBJScTOUvYqP6AE9d4MsydSC+UlhIMk4hoP76R8vUSCZRMkjOaDXstf/QoVZKbt94wyRZgAJ1G0BqI8L5ow86kLpA4wJEtxsRGymOE4bKUvApveBakYDNM9APkf+LbtbzWSseGjoZcSlycF9iN8Q2XNYKRrHbv3Lr5Y8JjdH/5y/6SHkNehTEZugaeGnSPSyCTWto1kQgHpxdWmhkLfJGNUGLmue7Mesj4TSms4J33mRpYVhNB/J333FCqIP0hr/E7BkkjEn7yZ4X7SQlh+xKPurapsnHRwiKmtsilmEFrnTE9iQr+pMr6M29qqFNv1tr5yumbaJw8JW9sB15tNsRv+dW6BjNanbsKz7HCgKUBc8tGy+7YuhXzAfViyRefcjK7eZW0Fbyt7AbybJTKz78W8NH7ye6LAwzOebXpeZ4D43fNIt8bKh26qgduSQv/7o+pAflkuqHZ99YWgHQ8h8OkZFi3eOiSYjsjhdZ/czWOdoPI/OnqIldzMPF5YlrKBLFX8VhRKVmqgsmWf5PHGulHhMkVlS+XG2UIseGy69ARa93D78Gsa+1n1kJr7EEB7Rh+27vUMxVYLdz1yMSvE5nalTAlg/ZeG8+XQ0cHuAI3KbQpHW2Q++RdXfm5JzD5WdJZUU+Zn8t8UUn85BH4RxZLeE0qJikgSsKoYVBc6YhiMjhPgkR95ReimY4Z0xCJdRo1gjexOFeODZMpQF6Yxnoic7IrdgsFA3iePTbFnPp3IAM1fAThWhXJUn3QInUOTd5o1qmTmn6REbL15g/JQNl+dqUoPkhleeb2V3kjqp1okmO3wMZbPknR3S1LZNmlS72/iBQUm+n2b/RCn4PjmM2";

function uuidFromSeed(seed: string) {
  const b = createHash("sha256").update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function buildAntigravity(provider: ProviderDef, c: Connection, req: ChatRequest): UpstreamSpec {
  const model = upstreamModelId(provider, req.model);
  const inner = chatToGemini(req, { thoughtSignature: AG_SIGNATURE });
  const gc = (inner.generationConfig ||= {});
  if (typeof gc.maxOutputTokens === "number" && gc.maxOutputTokens > 64000) gc.maxOutputTokens = 64000;
  delete gc.thinkingConfig; // Google rejects thinking fields on this path
  const sessionId = sessionIdFor(c, req);
  const numericSession = String(parseInt(createHash("sha256").update(sessionId).digest("hex").slice(0, 12), 16));
  inner.sessionId = numericSession;
  if (inner.tools?.length) inner.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  const conversation = uuidFromSeed(`antigravity:conversation:${sessionId}`);
  const trajectory = uuidFromSeed(`antigravity:trajectory:${sessionId}:${model}`);
  const step = Math.max(1, inner.contents.length * 2 - 1);
  const body = {
    project: c.data.projectId || "aicode-consumers",
    model,
    userAgent: "antigravity",
    requestId: `agent/${conversation}/${Date.now()}/${trajectory}/${step}`,
    request: inner,
  };
  const headers = { "content-type": "application/json", authorization: `Bearer ${c.data.accessToken}`, ...(provider.headers || {}) };
  return { url: `${provider.baseUrl}/v1internal:streamGenerateContent?alt=sse`, headers, body, streaming: true, decode: "gemini" };
}

function buildGeminiCli(provider: ProviderDef, c: Connection, req: ChatRequest): UpstreamSpec {
  const model = upstreamModelId(provider, req.model);
  const inner = chatToGemini(req);
  const body = { project: c.data.projectId, model, request: inner };
  const headers = { "content-type": "application/json", authorization: `Bearer ${c.data.accessToken}`, ...(provider.headers || {}) };
  return { url: `${provider.baseUrl}:streamGenerateContent?alt=sse`, headers, body, streaming: true, decode: "gemini" };
}

function buildGeminiApi(provider: ProviderDef, c: Connection, req: ChatRequest): UpstreamSpec {
  const model = upstreamModelId(provider, req.model);
  const body = chatToGemini(req);
  const headers = { "content-type": "application/json", "x-goog-api-key": c.data.apiKey || "" };
  return { url: `${provider.baseUrl}/${model}:streamGenerateContent?alt=sse`, headers, body, streaming: true, decode: "gemini" };
}

function buildOpenAI(provider: ProviderDef, c: Connection, req: ChatRequest): UpstreamSpec {
  const model = upstreamModelId(provider, req.model);
  const body = stripForUpstream({ ...req, model }, true);
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream", ...(provider.headers || {}) };
  const auth = provider.apiKeyHeader || { header: "authorization", scheme: "bearer" };
  headers[auth.header] = auth.scheme === "bearer" ? `Bearer ${c.data.apiKey || ""}` : c.data.apiKey || "";
  const url = provider.customBaseUrl && c.data.baseUrl ? c.data.baseUrl.replace(/\/$/, "") + "/chat/completions" : provider.baseUrl;
  return { url, headers, body, streaming: true, decode: "openai" };
}

export function buildUpstream(provider: ProviderDef, c: Connection, req: ChatRequest, rawClaude: ClaudeRequest | null, clientHeaders: Headers): UpstreamSpec {
  switch (provider.id) {
    case "claude":
    case "anthropic":
      return buildClaude(provider, c, req, provider.id === "claude" || provider.id === "anthropic" ? rawClaude : null, clientHeaders);
    case "codex":
      return buildCodex(provider, c, req);
    case "antigravity":
      return buildAntigravity(provider, c, req);
    case "gemini-cli":
      return buildGeminiCli(provider, c, req);
    case "gemini":
      return buildGeminiApi(provider, c, req);
    default:
      return buildOpenAI(provider, c, req);
  }
}

export const requestId = () => randomUUID();
