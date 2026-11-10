// Gemini generateContent <-> internal chat shape. Used for Antigravity, Gemini CLI and the Gemini API key provider.
import { chunk, parseDataUri, safeJson, textOf, type ChatChunk, type ChatRequest, type FinishReason, type Usage } from "./types";

interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: unknown };
}
interface Content {
  role: "user" | "model";
  parts: Part[];
}

export interface GeminiRequest {
  contents: Content[];
  systemInstruction?: { role?: string; parts: { text: string }[] };
  generationConfig?: Record<string, unknown>;
  tools?: { functionDeclarations: { name: string; description: string; parameters?: Record<string, unknown> }[] }[];
  toolConfig?: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } };
  sessionId?: string;
}

const UNSUPPORTED_SCHEMA_KEYS = new Set(["$schema", "$id", "$ref", "$defs", "definitions", "additionalProperties", "patternProperties", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "const", "examples", "default", "title", "readOnly", "writeOnly", "deprecated", "contentEncoding", "contentMediaType", "if", "then", "else", "not", "dependentRequired", "dependentSchemas", "unevaluatedProperties", "unevaluatedItems", "propertyNames", "contains", "minContains", "maxContains", "prefixItems"]);

/** Gemini accepts a strict JSON schema subset; flatten what it rejects. */
export function cleanSchema(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { type: "object", properties: {} };
  const s = { ...(input as Record<string, unknown>) };
  if (s.const !== undefined) {
    s.enum = [s.const];
    delete s.const;
  }
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf as Record<string, unknown>[]) Object.assign(s, { ...sub, properties: { ...(s.properties as object || {}), ...(sub.properties as object || {}) } });
    delete s.allOf;
  }
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(s[key])) {
      const first = (s[key] as Record<string, unknown>[]).find((x) => x && x.type !== "null") || (s[key] as Record<string, unknown>[])[0];
      Object.assign(s, cleanSchema(first));
      delete s[key];
    }
  }
  if (Array.isArray(s.type)) s.type = (s.type as string[]).find((t) => t !== "null") || "string";
  if (Array.isArray(s.enum)) {
    s.enum = (s.enum as unknown[]).map(String);
    if (!s.type) s.type = "string";
  }
  if (s.properties && !s.type) s.type = "object";
  if (s.type === "array" && !s.items) s.items = { type: "string" };
  for (const k of Object.keys(s)) if (UNSUPPORTED_SCHEMA_KEYS.has(k)) delete s[k];
  if (s.properties && typeof s.properties === "object") {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) props[k] = cleanSchema(v);
    s.properties = props;
    if (Array.isArray(s.required)) {
      s.required = (s.required as string[]).filter((r) => r in props);
      if (!(s.required as string[]).length) delete s.required;
    }
    if (!Object.keys(props).length && s.type === "object") s.properties = { reason: { type: "string" } };
  }
  if (s.items) s.items = cleanSchema(s.items);
  if (!s.type) s.type = "string";
  return s;
}

const fnName = (n: string) => {
  let s = n.replace(/[^a-zA-Z0-9_.:-]/g, "_");
  if (!/^[a-zA-Z_]/.test(s)) s = "_" + s;
  return s.slice(0, 64);
};

const EFFORT_TO_LEVEL: Record<string, string> = { none: "minimal", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

export function chatToGemini(req: ChatRequest, opts: { thoughtSignature?: string } = {}): GeminiRequest {
  const out: GeminiRequest = { contents: [], generationConfig: {} };
  const gc = out.generationConfig!;
  if (req.temperature !== undefined) gc.temperature = req.temperature;
  if (req.top_p !== undefined) gc.topP = req.top_p;
  if (req.max_tokens) gc.maxOutputTokens = req.max_tokens;
  if (req.reasoning_effort) gc.thinkingConfig = { includeThoughts: true, thinkingLevel: EFFORT_TO_LEVEL[req.reasoning_effort] || "medium" };
  const sys: string[] = [];
  const usedIds = new Set<string>();
  const uniqueId = (id: string) => {
    let out = id;
    let n = 1;
    while (usedIds.has(out)) out = `${id}_${n++}`;
    usedIds.add(out);
    return out;
  };
  const pendingResponses: Record<string, string[]> = {};
  for (const m of req.messages) if (m.role === "tool" && m.tool_call_id) (pendingResponses[m.tool_call_id] ||= []).push(textOf(m.content));
  const idMap: Record<string, string[]> = {};
  for (const m of req.messages) {
    if (m.role === "system") {
      sys.push(textOf(m.content));
      continue;
    }
    if (m.role === "tool") {
      const emitted = idMap[m.tool_call_id || ""]?.shift();
      out.contents.push({ role: "user", parts: [{ functionResponse: { id: emitted || m.tool_call_id, name: "tool", response: { result: textOf(m.content) } } }] });
      continue;
    }
    if (m.role === "assistant") {
      const parts: Part[] = [];
      const text = textOf(m.content);
      if (text) parts.push({ text });
      let first = true;
      for (const tc of m.tool_calls || []) {
        const id = uniqueId(tc.id);
        (idMap[tc.id] ||= []).push(id);
        const part: Part = { functionCall: { id, name: fnName(tc.function.name), args: safeJson(tc.function.arguments) } };
        if (first && opts.thoughtSignature) part.thoughtSignature = opts.thoughtSignature;
        first = false;
        parts.push(part);
      }
      if (parts.length) out.contents.push({ role: "model", parts });
      continue;
    }
    const parts: Part[] = [];
    if (typeof m.content === "string") {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const p of m.content || []) {
        if (p.type === "text" && p.text) parts.push({ text: p.text });
        else if (p.type === "image_url") {
          const d = parseDataUri(p.image_url.url);
          if (d) parts.push({ inlineData: { mimeType: d.mime, data: d.data } });
        }
      }
    }
    if (parts.length) out.contents.push({ role: "user", parts });
  }
  // fix function names in responses to match the call
  const callNames = new Map<string, string>();
  for (const c of out.contents) for (const p of c.parts) if (p.functionCall?.id) callNames.set(p.functionCall.id, p.functionCall.name);
  for (const c of out.contents) for (const p of c.parts) if (p.functionResponse?.id && callNames.has(p.functionResponse.id)) p.functionResponse.name = callNames.get(p.functionResponse.id)!;
  // merge consecutive same-role turns, ensure user first and last
  const merged: Content[] = [];
  for (const c of out.contents) {
    const last = merged[merged.length - 1];
    if (last && last.role === c.role) last.parts.push(...c.parts);
    else merged.push({ role: c.role, parts: [...c.parts] });
  }
  if (!merged.length || merged[0].role !== "user") merged.unshift({ role: "user", parts: [{ text: "..." }] });
  if (merged[merged.length - 1].role === "model") merged.push({ role: "user", parts: [{ text: "Continue." }] });
  out.contents = merged;
  if (sys.length) out.systemInstruction = { role: "user", parts: [{ text: sys.join("\n") }] };
  if (req.tools?.length) {
    out.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: fnName(t.function.name), description: t.function.description || "", parameters: cleanSchema(t.function.parameters) })) }];
    const tc = req.tool_choice;
    if (tc === "none") out.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    else if (tc === "required") out.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (typeof tc === "object") out.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [fnName(tc.function.name)] } };
    else out.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  return out;
}

export interface GeminiDecodeState {
  id: string;
  model: string;
  started: boolean;
  toolCount: number;
  usage: Usage | null;
  pendingSignature: string | null;
  finished: boolean;
}

export function newGeminiDecodeState(model: string): GeminiDecodeState {
  return { id: `chatcmpl-${Date.now()}`, model, started: false, toolCount: 0, usage: null, pendingSignature: null, finished: false };
}

function geminiUsage(u: Record<string, number> | undefined): Usage | null {
  if (!u) return null;
  const prompt = u.promptTokenCount || 0;
  const thoughts = u.thoughtsTokenCount || 0;
  let completion = u.candidatesTokenCount || 0;
  if (!completion && u.totalTokenCount) completion = Math.max(0, u.totalTokenCount - prompt - thoughts);
  return { prompt_tokens: prompt, completion_tokens: completion + thoughts, total_tokens: prompt + completion + thoughts, cached_tokens: u.cachedContentTokenCount || 0, reasoning_tokens: thoughts };
}

const finishMap: Record<string, FinishReason> = { STOP: "stop", MAX_TOKENS: "length", SAFETY: "content_filter", RECITATION: "content_filter" };

/** Decode one Gemini response object (a stream chunk or the full non-streaming body). Antigravity wraps it in `response`. */
export function decodeGeminiChunk(raw: Record<string, unknown>, st: GeminiDecodeState): ChatChunk[] {
  const response = (raw.response as Record<string, unknown>) || raw;
  const out: ChatChunk[] = [];
  const candidates = response.candidates as { content?: { parts?: Part[] }; finishReason?: string }[] | undefined;
  const usage = geminiUsage(response.usageMetadata as Record<string, number> | undefined);
  if (usage) st.usage = usage;
  if (response.error) throw new Error(JSON.stringify(response.error));
  if (!candidates?.[0]) return out;
  if (!st.started) {
    st.started = true;
    if (typeof response.modelVersion === "string") st.model = response.modelVersion;
    out.push(chunk(st.id, st.model, { role: "assistant" }));
  }
  const cand = candidates[0];
  for (const p of cand.content?.parts || []) {
    if (p.thoughtSignature) st.pendingSignature = p.thoughtSignature;
    if (p.functionCall) {
      const idx = st.toolCount++;
      const id = p.functionCall.id || `call_${Date.now()}_${idx}`;
      out.push(chunk(st.id, st.model, { tool_calls: [{ index: idx, id, type: "function", function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } }] }));
    } else if (p.thought && p.text) out.push(chunk(st.id, st.model, { reasoning_content: p.text }));
    else if (p.text) out.push(chunk(st.id, st.model, { content: p.text }));
    else if (p.inlineData) out.push(chunk(st.id, st.model, { content: `![image](data:${p.inlineData.mimeType};base64,${p.inlineData.data})` }));
  }
  if (cand.finishReason && !st.finished) {
    st.finished = true;
    let finish = finishMap[cand.finishReason] || "stop";
    if (finish === "stop" && st.toolCount > 0) finish = "tool_calls";
    out.push(chunk(st.id, st.model, {}, finish, st.usage || undefined));
  }
  return out;
}

/** Fallback: close a stream that ended without a finishReason. */
export function finishGemini(st: GeminiDecodeState): ChatChunk[] {
  if (st.finished || !st.started) return [];
  st.finished = true;
  return [chunk(st.id, st.model, {}, st.toolCount ? "tool_calls" : "stop", st.usage || undefined)];
}
