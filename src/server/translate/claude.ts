// Anthropic Messages <-> internal OpenAI chat shape.
import {
  chunk,
  parseDataUri,
  safeJson,
  textOf,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type ContentPart,
  type FinishReason,
  type ToolCall,
  type Usage,
} from "./types";

type ClaudeBlock =
  | { type: "text"; text: string; cache_control?: unknown }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: string | ClaudeBlock[]; is_error?: boolean }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "document"; source: unknown };

export interface ClaudeRequest {
  model: string;
  messages: { role: "user" | "assistant"; content: string | ClaudeBlock[] }[];
  system?: string | { type: "text"; text: string; cache_control?: unknown }[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: { name: string; description?: string; input_schema?: Record<string, unknown>; type?: string }[];
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string; disable_parallel_tool_use?: boolean };
  thinking?: { type: string; budget_tokens?: number };
  output_config?: { effort?: string };
  metadata?: Record<string, unknown>;
  stop_sequences?: string[];
  [k: string]: unknown;
}

const stripBilling = (t: string) => t.replace(/^x-anthropic-billing-header:[^\n]*(?:\r?\n)?/i, "");

export function claudeToChat(body: ClaudeRequest): ChatRequest {
  const out: ChatRequest = { model: body.model, messages: [], stream: body.stream };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.metadata) out.metadata = body.metadata;
  const effort = body.output_config?.effort;
  if (effort) out.reasoning_effort = effort;
  else if (body.thinking?.type === "enabled" || body.thinking?.type === "adaptive") out.reasoning_effort = "medium";
  if (body.system) {
    const text = Array.isArray(body.system) ? body.system.map((s) => stripBilling(s.text || "")).filter(Boolean).join("\n") : stripBilling(body.system);
    if (text) out.messages.push({ role: "system", content: text });
  }
  for (const m of body.messages || []) {
    if (typeof m.content === "string") {
      out.messages.push({ role: m.role, content: m.content });
      continue;
    }
    const parts: ContentPart[] = [];
    const toolCalls: ToolCall[] = [];
    const toolResults: ChatMessage[] = [];
    for (const b of m.content || []) {
      switch (b.type) {
        case "text":
          parts.push({ type: "text", text: b.text });
          break;
        case "image":
          if (b.source.type === "base64") parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
          else parts.push({ type: "image_url", image_url: { url: b.source.url } });
          break;
        case "tool_use":
          toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
          break;
        case "tool_result": {
          let text = "";
          if (typeof b.content === "string") text = b.content;
          else if (Array.isArray(b.content)) {
            text = b.content.filter((c): c is Extract<ClaudeBlock, { type: "text" }> => c.type === "text").map((c) => c.text).join("\n");
            if (!text && b.content.length) text = JSON.stringify(b.content);
          }
          toolResults.push({ role: "tool", tool_call_id: b.tool_use_id, content: text });
          break;
        }
        default:
          break;
      }
    }
    if (toolResults.length) {
      out.messages.push(...toolResults);
      if (parts.length) out.messages.push({ role: "user", content: collapse(parts) });
      continue;
    }
    if (toolCalls.length) {
      const msg: ChatMessage = { role: "assistant", content: parts.length ? collapse(parts) : null, tool_calls: toolCalls };
      out.messages.push(msg);
      continue;
    }
    out.messages.push({ role: m.role, content: parts.length ? collapse(parts) : "" });
  }
  fixMissingToolResponses(out.messages);
  if (body.tools?.length) {
    out.tools = body.tools
      .filter((t) => !t.type || t.type === "custom")
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } } }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    out.tool_choice = tc.type === "any" ? "required" : tc.type === "tool" && tc.name ? { type: "function", function: { name: tc.name } } : tc.type === "none" ? "none" : "auto";
  }
  return out;
}

function collapse(parts: ContentPart[]): string | ContentPart[] {
  return parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n") : parts;
}

export function fixMissingToolResponses(messages: ChatMessage[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const answered = new Set<string>();
    let insertAt = i + 1;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].role === "tool" && messages[j].tool_call_id) {
        answered.add(messages[j].tool_call_id!);
        insertAt = j + 1;
      } else break;
    }
    const missing = m.tool_calls.filter((tc) => !answered.has(tc.id)).map((tc): ChatMessage => ({ role: "tool", tool_call_id: tc.id, content: "[No response received]" }));
    if (missing.length) {
      messages.splice(insertAt, 0, ...missing);
      i = insertAt + missing.length - 1;
    }
  }
}

export function chatToClaude(req: ChatRequest): ClaudeRequest {
  const out: ClaudeRequest = { model: req.model, messages: [], max_tokens: req.max_tokens || 8192, stream: req.stream };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (typeof req.stop === "string") out.stop_sequences = [req.stop];
  else if (Array.isArray(req.stop)) out.stop_sequences = req.stop;
  if (req.metadata) out.metadata = req.metadata;
  const systemTexts: string[] = [];
  const blocksOf = (m: ChatMessage): ClaudeBlock[] => {
    const blocks: ClaudeBlock[] = [];
    if (m.role === "tool") {
      blocks.push({ type: "tool_result", tool_use_id: m.tool_call_id || "", content: textOf(m.content) });
      return blocks;
    }
    if (typeof m.content === "string") {
      if (m.content) blocks.push({ type: "text", text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "text" && p.text) blocks.push({ type: "text", text: p.text });
        else if (p.type === "image_url") {
          const d = parseDataUri(p.image_url.url);
          if (d) blocks.push({ type: "image", source: { type: "base64", media_type: d.mime, data: d.data } });
          else if (/^https?:/.test(p.image_url.url)) blocks.push({ type: "image", source: { type: "url", url: p.image_url.url } });
        }
      }
    }
    for (const tc of m.tool_calls || []) {
      blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: safeJson(tc.function.arguments) });
    }
    return blocks;
  };
  for (const m of req.messages) {
    if (m.role === "system") {
      systemTexts.push(textOf(m.content));
      continue;
    }
    const role: "user" | "assistant" = m.role === "assistant" ? "assistant" : "user";
    const blocks = blocksOf(m);
    if (!blocks.length) continue;
    const last = out.messages[out.messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else out.messages.push({ role, content: blocks });
  }
  if (systemTexts.length) out.system = systemTexts.join("\n");
  if (out.messages.length === 0 || out.messages[0].role !== "user") out.messages.unshift({ role: "user", content: [{ type: "text", text: "..." }] });
  if (req.tools?.length) out.tools = req.tools.map((t) => ({ name: t.function.name, description: t.function.description || "", input_schema: t.function.parameters || { type: "object", properties: {} } }));
  if (req.tool_choice) {
    const tc = req.tool_choice;
    out.tool_choice = tc === "required" ? { type: "any" } : tc === "none" ? { type: "none" } : typeof tc === "object" ? { type: "tool", name: tc.function.name } : { type: "auto" };
  }
  if (req.reasoning_effort) {
    const budget = { low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 32768 }[req.reasoning_effort] || 8192;
    if (req.reasoning_effort !== "none" && req.reasoning_effort !== "minimal") {
      out.thinking = { type: "enabled", budget_tokens: Math.min(budget, Math.max(1024, (out.max_tokens || 8192) - 1024)) };
      if ((out.max_tokens || 0) <= budget) out.max_tokens = budget + 4096;
    }
  }
  return out;
}

// ---- Claude SSE events -> internal chunks ----

export interface ClaudeDecodeState {
  id: string;
  model: string;
  started: boolean;
  blocks: Map<number, { kind: "text" | "tool" | "thinking"; toolIndex?: number }>;
  toolCount: number;
  usage: Usage;
  stopReason: string | null;
}

export function newClaudeDecodeState(model: string): ClaudeDecodeState {
  return { id: `chatcmpl-${Date.now()}`, model, started: false, blocks: new Map(), toolCount: 0, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, stopReason: null };
}

function claudeUsage(u: Record<string, number> | undefined, prev: Usage): Usage {
  if (!u) return prev;
  const input = u.input_tokens ?? 0;
  const cached = u.cache_read_input_tokens ?? prev.cached_tokens ?? 0;
  const creation = u.cache_creation_input_tokens ?? prev.cache_creation_tokens ?? 0;
  const prompt = (input || Math.max(0, prev.prompt_tokens - (prev.cached_tokens || 0) - (prev.cache_creation_tokens || 0))) + cached + creation;
  const completion = u.output_tokens ?? prev.completion_tokens;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cached_tokens: cached, cache_creation_tokens: creation };
}

const finishFromClaude = (r: string | null): FinishReason => (r === "max_tokens" ? "length" : r === "tool_use" ? "tool_calls" : "stop");

export function decodeClaudeEvent(ev: Record<string, unknown>, st: ClaudeDecodeState): ChatChunk[] {
  const out: ChatChunk[] = [];
  const type = ev.type as string;
  if (type === "message_start") {
    const msg = ev.message as { id?: string; model?: string; usage?: Record<string, number> };
    st.id = msg?.id ? `chatcmpl-${msg.id}` : st.id;
    st.model = msg?.model || st.model;
    st.usage = claudeUsage(msg?.usage, st.usage);
    st.started = true;
    out.push(chunk(st.id, st.model, { role: "assistant" }));
    return out;
  }
  if (type === "content_block_start") {
    const idx = ev.index as number;
    const cb = ev.content_block as { type: string; id?: string; name?: string; text?: string };
    if (cb.type === "tool_use") {
      const toolIndex = st.toolCount++;
      st.blocks.set(idx, { kind: "tool", toolIndex });
      out.push(chunk(st.id, st.model, { tool_calls: [{ index: toolIndex, id: cb.id, type: "function", function: { name: cb.name, arguments: "" } }] }));
    } else if (cb.type === "thinking") st.blocks.set(idx, { kind: "thinking" });
    else {
      st.blocks.set(idx, { kind: "text" });
      if (cb.text) out.push(chunk(st.id, st.model, { content: cb.text }));
    }
    return out;
  }
  if (type === "content_block_delta") {
    const idx = ev.index as number;
    const d = ev.delta as { type: string; text?: string; partial_json?: string; thinking?: string };
    const b = st.blocks.get(idx);
    if (d.type === "text_delta" && d.text) out.push(chunk(st.id, st.model, { content: d.text }));
    else if (d.type === "input_json_delta" && b?.kind === "tool") out.push(chunk(st.id, st.model, { tool_calls: [{ index: b.toolIndex!, function: { arguments: d.partial_json || "" } }] }));
    else if (d.type === "thinking_delta" && d.thinking) out.push(chunk(st.id, st.model, { reasoning_content: d.thinking }));
    return out;
  }
  if (type === "message_delta") {
    const d = ev.delta as { stop_reason?: string | null };
    st.usage = claudeUsage(ev.usage as Record<string, number> | undefined, st.usage);
    st.stopReason = d?.stop_reason ?? st.stopReason;
    return out;
  }
  if (type === "message_stop") {
    out.push(chunk(st.id, st.model, {}, finishFromClaude(st.stopReason), st.usage));
    return out;
  }
  if (type === "error") {
    throw new Error(JSON.stringify(ev.error || ev));
  }
  return out;
}

/** Non-streaming Claude response -> single final chunk sequence. */
export function decodeClaudeMessage(msg: Record<string, unknown>): ChatChunk[] {
  const st = newClaudeDecodeState((msg.model as string) || "claude");
  const out = decodeClaudeEvent({ type: "message_start", message: msg }, st);
  const content = (msg.content as ClaudeBlock[]) || [];
  content.forEach((b, i) => {
    if (b.type === "text") out.push(...decodeClaudeEvent({ type: "content_block_start", index: i, content_block: { type: "text", text: b.text } }, st));
    else if (b.type === "tool_use") {
      out.push(...decodeClaudeEvent({ type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name } }, st));
      out.push(...decodeClaudeEvent({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input || {}) } }, st));
    } else if (b.type === "thinking") {
      out.push(...decodeClaudeEvent({ type: "content_block_start", index: i, content_block: { type: "thinking" } }, st));
      out.push(...decodeClaudeEvent({ type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking } }, st));
    }
  });
  out.push(...decodeClaudeEvent({ type: "message_delta", delta: { stop_reason: msg.stop_reason as string }, usage: msg.usage }, st));
  out.push(...decodeClaudeEvent({ type: "message_stop" }, st));
  return out;
}

// ---- internal chunks -> Claude SSE events ----

export interface ClaudeEncodeState {
  started: boolean;
  messageId: string;
  model: string;
  nextIndex: number;
  textIndex: number | null;
  thinkingIndex: number | null;
  tools: Map<number, { blockIndex: number; args: string; name: string }>;
  usage: Usage | null;
}

export function newClaudeEncodeState(model: string): ClaudeEncodeState {
  return { started: false, messageId: `msg_${Date.now().toString(36)}`, model, nextIndex: 0, textIndex: null, thinkingIndex: null, tools: new Map(), usage: null };
}

export function encodeClaudeEvents(c: ChatChunk, st: ClaudeEncodeState): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const choice = c.choices?.[0];
  if (!choice) return out;
  if (c.usage) st.usage = c.usage;
  if (!st.started) {
    st.started = true;
    if (c.id && c.id.length > 10) st.messageId = c.id.replace(/^chatcmpl-/, "");
    out.push({ type: "message_start", message: { id: st.messageId, type: "message", role: "assistant", model: c.model || st.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  const d = choice.delta || {};
  const closeText = () => {
    if (st.textIndex !== null) {
      out.push({ type: "content_block_stop", index: st.textIndex });
      st.textIndex = null;
    }
  };
  const closeThinking = () => {
    if (st.thinkingIndex !== null) {
      out.push({ type: "content_block_stop", index: st.thinkingIndex });
      st.thinkingIndex = null;
    }
  };
  if (d.reasoning_content) {
    closeText();
    if (st.thinkingIndex === null) {
      st.thinkingIndex = st.nextIndex++;
      out.push({ type: "content_block_start", index: st.thinkingIndex, content_block: { type: "thinking", thinking: "" } });
    }
    out.push({ type: "content_block_delta", index: st.thinkingIndex, delta: { type: "thinking_delta", thinking: d.reasoning_content } });
  }
  if (d.content) {
    closeThinking();
    if (st.textIndex === null) {
      st.textIndex = st.nextIndex++;
      out.push({ type: "content_block_start", index: st.textIndex, content_block: { type: "text", text: "" } });
    }
    out.push({ type: "content_block_delta", index: st.textIndex, delta: { type: "text_delta", text: d.content } });
  }
  for (const tc of d.tool_calls || []) {
    const idx = tc.index ?? 0;
    if (tc.id && !st.tools.has(idx)) {
      closeThinking();
      closeText();
      const blockIndex = st.nextIndex++;
      st.tools.set(idx, { blockIndex, args: "", name: tc.function?.name || "" });
      out.push({ type: "content_block_start", index: blockIndex, content_block: { type: "tool_use", id: tc.id, name: tc.function?.name || "", input: {} } });
    }
    if (tc.function?.arguments) {
      const t = st.tools.get(idx);
      if (t) t.args += tc.function.arguments;
    }
  }
  if (choice.finish_reason) {
    closeThinking();
    closeText();
    for (const t of st.tools.values()) {
      if (t.args) out.push({ type: "content_block_delta", index: t.blockIndex, delta: { type: "input_json_delta", partial_json: t.args } });
      out.push({ type: "content_block_stop", index: t.blockIndex });
    }
    const u = st.usage;
    const usage = u
      ? {
          input_tokens: Math.max(0, u.prompt_tokens - (u.cached_tokens || 0) - (u.cache_creation_tokens || 0)),
          output_tokens: u.completion_tokens,
          ...(u.cached_tokens ? { cache_read_input_tokens: u.cached_tokens } : {}),
          ...(u.cache_creation_tokens ? { cache_creation_input_tokens: u.cache_creation_tokens } : {}),
        }
      : { input_tokens: 0, output_tokens: 0 };
    const stop = choice.finish_reason === "length" ? "max_tokens" : choice.finish_reason === "tool_calls" || st.tools.size ? "tool_use" : "end_turn";
    out.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage });
    out.push({ type: "message_stop" });
  }
  return out;
}
