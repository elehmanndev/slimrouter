// OpenAI chat completions SSE decode (upstream) and encode (client), plus the non-streaming object.
import { chunk, type ChatChunk, type ChatRequest, type ChunkDelta, type FinishReason, type Usage } from "./types";

export function decodeOpenAIChunk(raw: Record<string, unknown>, model: string): ChatChunk[] {
  if (raw.error) throw new Error(JSON.stringify(raw.error));
  const choices = raw.choices as { delta?: ChunkDelta & { reasoning?: string }; finish_reason?: FinishReason | null }[] | undefined;
  const usage = normalizeOpenAIUsage(raw.usage as Record<string, unknown> | undefined);
  const id = (raw.id as string) || `chatcmpl-${Date.now()}`;
  const m = (raw.model as string) || model;
  if (!choices?.length) return usage ? [chunk(id, m, {}, null, usage)] : [];
  const c = choices[0];
  const delta: ChunkDelta = { ...(c.delta || {}) };
  if (!delta.reasoning_content && (c.delta as { reasoning?: string })?.reasoning) delta.reasoning_content = (c.delta as { reasoning?: string }).reasoning;
  delete (delta as { reasoning?: string }).reasoning;
  return [chunk(id, m, delta, c.finish_reason ?? null, usage || undefined)];
}

export function normalizeOpenAIUsage(u: Record<string, unknown> | undefined): Usage | null {
  if (!u) return null;
  const prompt = Number(u.prompt_tokens) || 0;
  const completion = Number(u.completion_tokens) || 0;
  const details = (u.prompt_tokens_details as Record<string, number>) || {};
  const cdetails = (u.completion_tokens_details as Record<string, number>) || {};
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, cached_tokens: details.cached_tokens || 0, cache_creation_tokens: details.cache_creation_tokens || 0, reasoning_tokens: cdetails.reasoning_tokens || 0 };
}

/** Full non-streaming chat.completion object from a non-streaming upstream body. */
export function decodeOpenAICompletion(raw: Record<string, unknown>, model: string): ChatChunk[] {
  if (raw.error) throw new Error(JSON.stringify(raw.error));
  const id = (raw.id as string) || `chatcmpl-${Date.now()}`;
  const m = (raw.model as string) || model;
  const choice = (raw.choices as { message?: Record<string, unknown>; finish_reason?: FinishReason }[])?.[0];
  const out: ChatChunk[] = [chunk(id, m, { role: "assistant" })];
  const msg = choice?.message || {};
  if (msg.reasoning_content) out.push(chunk(id, m, { reasoning_content: String(msg.reasoning_content) }));
  if (msg.content) out.push(chunk(id, m, { content: String(msg.content) }));
  const calls = (msg.tool_calls as { id: string; function: { name: string; arguments: string } }[]) || [];
  calls.forEach((tc, i) => out.push(chunk(id, m, { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] })));
  out.push(chunk(id, m, {}, choice?.finish_reason || (calls.length ? "tool_calls" : "stop"), normalizeOpenAIUsage(raw.usage as Record<string, unknown>) || undefined));
  return out;
}

export function usageForClient(u: Usage | null | undefined) {
  if (!u) return undefined;
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    total_tokens: u.total_tokens,
    prompt_tokens_details: { cached_tokens: u.cached_tokens || 0 },
    completion_tokens_details: { reasoning_tokens: u.reasoning_tokens || 0 },
  };
}

/** Aggregate chunks into a chat.completion object. */
export function completionFromChunks(chunks: ChatChunk[], model: string): Record<string, unknown> {
  let content = "";
  let reasoning = "";
  const tools = new Map<number, { id: string; name: string; args: string }>();
  let finish: FinishReason = "stop";
  let usage: Usage | null = null;
  let id = `chatcmpl-${Date.now()}`;
  for (const c of chunks) {
    if (c.id) id = c.id;
    if (c.usage) usage = c.usage;
    const d = c.choices[0]?.delta || {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    for (const tc of d.tool_calls || []) {
      const t = tools.get(tc.index) || { id: tc.id || "", name: "", args: "" };
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name = tc.function.name;
      if (tc.function?.arguments) t.args += tc.function.arguments;
      tools.set(tc.index, t);
    }
    if (c.choices[0]?.finish_reason) finish = c.choices[0].finish_reason;
  }
  const message: Record<string, unknown> = { role: "assistant", content: content || (tools.size ? null : "") };
  if (reasoning) message.reasoning_content = reasoning;
  if (tools.size) message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args || "{}" } }));
  return { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finish }], usage: usageForClient(usage) };
}

export function stripForUpstream(req: ChatRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream };
  if (stream) body.stream_options = { include_usage: true };
  if (req.max_tokens) body.max_tokens = req.max_tokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.tools?.length) body.tools = req.tools;
  if (req.tool_choice) body.tool_choice = req.tool_choice;
  if (req.stop) body.stop = req.stop;
  if (req.reasoning_effort && req.reasoning_effort !== "none") body.reasoning_effort = req.reasoning_effort === "max" || req.reasoning_effort === "xhigh" ? "high" : req.reasoning_effort;
  return body;
}
