// OpenAI Responses API <-> internal chat shape (used by Codex upstream and /v1/responses clients).
import { chunk, safeJson, textOf, type ChatChunk, type ChatMessage, type ChatRequest, type ContentPart, type FinishReason, type ToolCall, type Usage } from "./types";

export interface ResponsesRequest {
  model: string;
  input: string | ResponsesItem[];
  instructions?: string;
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  reasoning?: { effort?: string; summary?: string };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  store?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  text?: unknown;
  parallel_tool_calls?: boolean;
  [k: string]: unknown;
}

type ResponsesItem =
  | { type?: "message"; role: string; content: string | { type: string; text?: string; image_url?: string; detail?: string }[]; id?: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string; id?: string }
  | { type: "function_call_output"; call_id: string; output: string | unknown }
  | { type: "reasoning"; summary?: { text: string }[]; encrypted_content?: string; id?: string }
  | { type: string; [k: string]: unknown };

export function normalizeInput(input: ResponsesRequest["input"]): ResponsesItem[] {
  if (typeof input === "string") return [{ type: "message", role: "user", content: [{ type: "input_text", text: input.trim() || "..." }] }];
  if (Array.isArray(input) && input.length) return input;
  return [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
}

export function responsesToChat(body: ResponsesRequest): ChatRequest {
  const out: ChatRequest = { model: body.model, messages: [], stream: body.stream };
  if (body.instructions) out.messages.push({ role: "system", content: body.instructions });
  if (body.max_output_tokens) out.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.reasoning?.effort) out.reasoning_effort = body.reasoning.effort;
  let assistant: ChatMessage | null = null;
  const flush = () => {
    if (assistant) out.messages.push(assistant);
    assistant = null;
  };
  for (const item of normalizeInput(body.input)) {
    const type = (item as { type?: string }).type || ((item as { role?: string }).role ? "message" : "");
    if (type === "message") {
      flush();
      const it = item as Extract<ResponsesItem, { role: string }>;
      const role = it.role === "developer" ? "system" : (it.role as ChatMessage["role"]);
      const content: string | ContentPart[] = Array.isArray(it.content)
        ? it.content
            .map((c): ContentPart | null => {
              if (c.type === "input_text" || c.type === "output_text" || c.type === "text") return { type: "text", text: c.text || "" };
              if (c.type === "input_image" && c.image_url) return { type: "image_url", image_url: { url: c.image_url, detail: c.detail || "auto" } };
              return null;
            })
            .filter((c): c is ContentPart => !!c)
        : String(it.content ?? "");
      out.messages.push({ role, content });
    } else if (type === "function_call") {
      const it = item as Extract<ResponsesItem, { type: "function_call" }>;
      if (!it.name) continue;
      if (!assistant) assistant = { role: "assistant", content: null, tool_calls: [] };
      assistant.tool_calls!.push({ id: it.call_id, type: "function", function: { name: it.name, arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments || {}) } });
    } else if (type === "function_call_output") {
      flush();
      const it = item as Extract<ResponsesItem, { type: "function_call_output" }>;
      out.messages.push({ role: "tool", tool_call_id: it.call_id, content: typeof it.output === "string" ? it.output : JSON.stringify(it.output ?? "") });
    } else if (type === "reasoning") {
      // dropped: continuity-only
    }
  }
  flush();
  if (Array.isArray(body.tools)) {
    out.tools = (body.tools as Record<string, unknown>[])
      .filter((t) => t?.type === "function")
      .map((t) => {
        const fn = (t.function as Record<string, unknown>) || t;
        return { type: "function" as const, function: { name: String(fn.name), description: (fn.description as string) || "", parameters: (fn.parameters as Record<string, unknown>) || { type: "object", properties: {} } } };
      });
  }
  const tc = body.tool_choice as string | { type?: string; name?: string } | undefined;
  if (tc) {
    if (typeof tc === "string") out.tool_choice = tc as ChatRequest["tool_choice"];
    else if (tc.type === "function" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
  }
  return out;
}

export function chatToResponses(req: ChatRequest): ResponsesRequest {
  const input: ResponsesItem[] = [];
  let instructions = "";
  for (const m of req.messages) {
    if (m.role === "system") {
      instructions += (instructions ? "\n" : "") + textOf(m.content);
      continue;
    }
    if (m.role === "tool") {
      input.push({ type: "function_call_output", call_id: m.tool_call_id || "", output: textOf(m.content) });
      continue;
    }
    if (m.role === "assistant") {
      const text = textOf(m.content);
      if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const tc of m.tool_calls || []) input.push({ type: "function_call", call_id: tc.id.slice(0, 64), name: tc.function.name, arguments: tc.function.arguments || "{}" });
      continue;
    }
    const content = typeof m.content === "string"
      ? [{ type: "input_text", text: m.content }]
      : (m.content || []).map((p) => (p.type === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: p.image_url.url, detail: p.image_url.detail || "auto" }));
    input.push({ type: "message", role: "user", content });
  }
  const out: ResponsesRequest = { model: req.model, input, stream: true, store: false };
  if (instructions) out.instructions = instructions;
  if (req.max_tokens) out.max_output_tokens = req.max_tokens;
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.tools?.length) out.tools = req.tools.map((t) => ({ type: "function", name: t.function.name, description: t.function.description || "", parameters: t.function.parameters || { type: "object", properties: {} } }));
  if (req.tool_choice) out.tool_choice = typeof req.tool_choice === "object" ? { type: "function", name: req.tool_choice.function.name } : req.tool_choice;
  if (req.reasoning_effort) out.reasoning = { effort: req.reasoning_effort };
  return out;
}

// ---- Responses SSE -> internal chunks ----
export interface ResponsesDecodeState {
  id: string;
  model: string;
  started: boolean;
  toolIndexById: Map<string, number>;
  nextTool: number;
  argsEmitted: Set<number>;
  usage: Usage | null;
  sawTool: boolean;
}

export function newResponsesDecodeState(model: string): ResponsesDecodeState {
  return { id: `chatcmpl-${Date.now()}`, model, started: false, toolIndexById: new Map(), nextTool: 0, argsEmitted: new Set(), usage: null, sawTool: false };
}

function responsesUsage(u: Record<string, unknown> | undefined): Usage | null {
  if (!u) return null;
  const prompt = Number(u.input_tokens) || 0;
  const completion = Number(u.output_tokens) || 0;
  const cached = Number((u.input_tokens_details as Record<string, number>)?.cached_tokens) || 0;
  const reasoning = Number((u.output_tokens_details as Record<string, number>)?.reasoning_tokens) || 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cached_tokens: cached, reasoning_tokens: reasoning };
}

export function decodeResponsesEvent(ev: Record<string, unknown>, st: ResponsesDecodeState): ChatChunk[] {
  const out: ChatChunk[] = [];
  const type = ev.type as string;
  const start = () => {
    if (!st.started) {
      st.started = true;
      out.push(chunk(st.id, st.model, { role: "assistant" }));
    }
  };
  if (type === "response.created") {
    const r = ev.response as { id?: string; model?: string };
    if (r?.id) st.id = `chatcmpl-${r.id}`;
    if (r?.model) st.model = r.model;
    start();
  } else if (type === "response.output_text.delta") {
    start();
    if (ev.delta) out.push(chunk(st.id, st.model, { content: String(ev.delta) }));
  } else if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
    start();
    if (ev.delta) out.push(chunk(st.id, st.model, { reasoning_content: String(ev.delta) }));
  } else if (type === "response.output_item.added") {
    const item = ev.item as { type?: string; id?: string; call_id?: string; name?: string };
    if (item?.type === "function_call") {
      start();
      st.sawTool = true;
      const key = item.id || item.call_id || `tool_${st.nextTool}`;
      const idx = st.nextTool++;
      st.toolIndexById.set(key, idx);
      out.push(chunk(st.id, st.model, { tool_calls: [{ index: idx, id: item.call_id || key, type: "function", function: { name: item.name || "", arguments: "" } }] }));
    }
  } else if (type === "response.function_call_arguments.delta") {
    const idx = st.toolIndexById.get(String(ev.item_id)) ?? Math.max(0, st.nextTool - 1);
    st.argsEmitted.add(idx);
    if (ev.delta) out.push(chunk(st.id, st.model, { tool_calls: [{ index: idx, function: { arguments: String(ev.delta) } }] }));
  } else if (type === "response.output_item.done") {
    const item = ev.item as { type?: string; id?: string; arguments?: string };
    if (item?.type === "function_call" && typeof item.arguments === "string" && item.arguments) {
      const idx = st.toolIndexById.get(item.id || "") ?? Math.max(0, st.nextTool - 1);
      if (!st.argsEmitted.has(idx)) {
        st.argsEmitted.add(idx);
        out.push(chunk(st.id, st.model, { tool_calls: [{ index: idx, function: { arguments: item.arguments } }] }));
      }
    }
  } else if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
    start();
    const r = ev.response as { usage?: Record<string, unknown>; status?: string; incomplete_details?: { reason?: string } } | undefined;
    st.usage = responsesUsage(r?.usage) || st.usage;
    const finish: FinishReason = r?.incomplete_details?.reason === "max_output_tokens" ? "length" : st.sawTool ? "tool_calls" : "stop";
    out.push(chunk(st.id, st.model, {}, finish, st.usage || undefined));
  } else if (type === "response.failed" || type === "error") {
    const err = (ev.response as { error?: { message?: string } })?.error || (ev.error as { message?: string }) || ev;
    throw new Error(typeof err === "string" ? err : (err as { message?: string }).message || JSON.stringify(err));
  }
  return out;
}

// ---- internal chunks -> Responses SSE events (for /v1/responses clients) ----
export interface ResponsesEncodeState {
  responseId: string;
  model: string;
  created: boolean;
  seq: number;
  outputIndex: number;
  message: { id: string; index: number; text: string } | null;
  reasoning: { id: string; index: number; text: string } | null;
  tools: Map<number, { id: string; callId: string; name: string; args: string; index: number }>;
  outputs: Record<string, unknown>[];
  usage: Usage | null;
}

export function newResponsesEncodeState(model: string): ResponsesEncodeState {
  return { responseId: `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, model, created: false, seq: 0, outputIndex: 0, message: null, reasoning: null, tools: new Map(), outputs: [], usage: null };
}

export function encodeResponsesEvents(c: ChatChunk, st: ResponsesEncodeState): { event: string; data: Record<string, unknown> }[] {
  const out: { event: string; data: Record<string, unknown> }[] = [];
  const emit = (event: string, data: Record<string, unknown>) => out.push({ event, data: { type: event, sequence_number: st.seq++, ...data } });
  const base = () => ({ id: st.responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: c.model || st.model, status: "in_progress", output: [] as unknown[] });
  if (!st.created) {
    st.created = true;
    emit("response.created", { response: base() });
    emit("response.in_progress", { response: base() });
  }
  if (c.usage) st.usage = c.usage;
  const choice = c.choices?.[0];
  if (!choice) return out;
  const d = choice.delta || {};
  const closeReasoning = () => {
    if (!st.reasoning) return;
    const item = { id: st.reasoning.id, type: "reasoning", summary: st.reasoning.text ? [{ type: "summary_text", text: st.reasoning.text }] : [] };
    emit("response.output_item.done", { output_index: st.reasoning.index, item });
    st.outputs.push(item);
    st.reasoning = null;
  };
  const closeMessage = () => {
    if (!st.message) return;
    emit("response.output_text.done", { item_id: st.message.id, output_index: st.message.index, content_index: 0, text: st.message.text });
    emit("response.content_part.done", { item_id: st.message.id, output_index: st.message.index, content_index: 0, part: { type: "output_text", text: st.message.text, annotations: [] } });
    const item = { id: st.message.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: st.message.text, annotations: [] }] };
    emit("response.output_item.done", { output_index: st.message.index, item });
    st.outputs.push(item);
    st.message = null;
  };
  if (d.reasoning_content) {
    closeMessage();
    if (!st.reasoning) {
      st.reasoning = { id: `rs_${st.responseId}_${st.outputIndex}`, index: st.outputIndex++, text: "" };
      emit("response.output_item.added", { output_index: st.reasoning.index, item: { id: st.reasoning.id, type: "reasoning", summary: [] } });
    }
    st.reasoning.text += d.reasoning_content;
    emit("response.reasoning_summary_text.delta", { item_id: st.reasoning.id, output_index: st.reasoning.index, summary_index: 0, delta: d.reasoning_content });
  }
  if (d.content) {
    closeReasoning();
    if (!st.message) {
      st.message = { id: `msg_${st.responseId}_${st.outputIndex}`, index: st.outputIndex++, text: "" };
      emit("response.output_item.added", { output_index: st.message.index, item: { id: st.message.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
      emit("response.content_part.added", { item_id: st.message.id, output_index: st.message.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    }
    st.message.text += d.content;
    emit("response.output_text.delta", { item_id: st.message.id, output_index: st.message.index, content_index: 0, delta: d.content });
  }
  for (const tc of d.tool_calls || []) {
    const idx = tc.index ?? 0;
    if (tc.id && !st.tools.has(idx)) {
      closeReasoning();
      closeMessage();
      const t = { id: `fc_${st.responseId}_${st.outputIndex}`, callId: tc.id, name: tc.function?.name || "", args: "", index: st.outputIndex++ };
      st.tools.set(idx, t);
      emit("response.output_item.added", { output_index: t.index, item: { id: t.id, type: "function_call", status: "in_progress", call_id: t.callId, name: t.name, arguments: "" } });
    }
    const t = st.tools.get(idx);
    if (t && tc.function?.arguments) {
      t.args += tc.function.arguments;
      emit("response.function_call_arguments.delta", { item_id: t.id, output_index: t.index, delta: tc.function.arguments });
    }
  }
  if (choice.finish_reason) {
    closeReasoning();
    closeMessage();
    for (const t of st.tools.values()) {
      emit("response.function_call_arguments.done", { item_id: t.id, output_index: t.index, arguments: t.args || "{}" });
      const item = { id: t.id, type: "function_call", status: "completed", call_id: t.callId, name: t.name, arguments: t.args || "{}" };
      emit("response.output_item.done", { output_index: t.index, item });
      st.outputs.push(item);
    }
    const u = st.usage;
    const usage = u ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens, total_tokens: u.total_tokens, input_tokens_details: { cached_tokens: u.cached_tokens || 0 }, output_tokens_details: { reasoning_tokens: u.reasoning_tokens || 0 } } : undefined;
    emit("response.completed", { response: { ...base(), status: choice.finish_reason === "length" ? "incomplete" : "completed", output: st.outputs, usage } });
  }
  return out;
}

/** Build a non-streaming Responses object from the aggregated chunk stream. */
export function responsesObjectFromChunks(chunks: ChatChunk[], model: string): Record<string, unknown> {
  const st = newResponsesEncodeState(model);
  let completed: Record<string, unknown> | null = null;
  for (const c of chunks) for (const ev of encodeResponsesEvents(c, st)) if (ev.event === "response.completed") completed = ev.data.response as Record<string, unknown>;
  return completed || { id: st.responseId, object: "response", status: "completed", model, output: [] };
}

export const toolCallFromParts = (id: string, name: string, args: string): ToolCall => ({ id, type: "function", function: { name, arguments: args } });
export const argsOf = safeJson;
