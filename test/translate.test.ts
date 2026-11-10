import { describe, expect, it } from "vitest";
import { chatToClaude, claudeToChat, decodeClaudeEvent, encodeClaudeEvents, newClaudeDecodeState, newClaudeEncodeState } from "@/server/translate/claude";
import { chatToResponses, decodeResponsesEvent, encodeResponsesEvents, newResponsesDecodeState, newResponsesEncodeState, responsesToChat } from "@/server/translate/responses";
import { chatToGemini, cleanSchema, decodeGeminiChunk, newGeminiDecodeState } from "@/server/translate/gemini";
import { completionFromChunks } from "@/server/translate/openai";
import type { ChatChunk } from "@/server/translate/types";

describe("claude <-> chat", () => {
  it("maps system, tool_use and tool_result blocks", () => {
    const chat = claudeToChat({
      model: "claude-opus-5-5",
      system: [{ type: "text", text: "x-anthropic-billing-header: junk\nBe terse" }],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { path: "a" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] },
      ],
      tools: [{ name: "Read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      max_tokens: 100,
    });
    expect(chat.messages[0]).toEqual({ role: "system", content: "Be terse" });
    expect(chat.messages[2].tool_calls?.[0].function.name).toBe("Read");
    expect(chat.messages[3]).toMatchObject({ role: "tool", tool_call_id: "t1", content: "file body" });
    expect(chat.tools?.[0].function.name).toBe("Read");
    const back = chatToClaude(chat);
    expect(back.system).toBe("Be terse");
    expect(back.messages).toHaveLength(3);
    expect((back.messages[1].content as { type: string }[])[0].type).toBe("tool_use");
  });

  it("inserts missing tool results so the history stays valid", () => {
    const chat = claudeToChat({
      model: "m",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
        { role: "user", content: "next question" },
      ],
    });
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
  });

  it("round trips a streamed tool call through decode and encode", () => {
    const st = newClaudeDecodeState("m");
    const events = [
      { type: "message_start", message: { id: "msg_1", model: "claude-opus-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 5 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "Read_ide" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ];
    const chunks = events.flatMap((e) => decodeClaudeEvent(e, st));
    const final = chunks[chunks.length - 1];
    expect(final.choices[0].finish_reason).toBe("tool_calls");
    expect(final.usage).toMatchObject({ prompt_tokens: 15, completion_tokens: 7, cached_tokens: 5 });
    const enc = newClaudeEncodeState("m");
    const out = chunks.flatMap((c) => encodeClaudeEvents(c, enc));
    const types = out.map((e) => e.type);
    expect(types[0]).toBe("message_start");
    expect(types).toContain("content_block_start");
    expect(types[types.length - 1]).toBe("message_stop");
    const delta = out.find((e) => e.type === "message_delta") as { delta: { stop_reason: string }; usage: { input_tokens: number; cache_read_input_tokens?: number } };
    expect(delta.delta.stop_reason).toBe("tool_use");
    expect(delta.usage.input_tokens).toBe(10);
    expect(delta.usage.cache_read_input_tokens).toBe(5);
    const toolStart = out.find((e) => e.type === "content_block_start" && (e.content_block as { type: string }).type === "tool_use") as { content_block: { name: string } };
    expect(toolStart.content_block.name).toBe("Read_ide");
  });
});

describe("responses <-> chat", () => {
  it("converts input items and function outputs", () => {
    const chat = responsesToChat({
      model: "gpt-6-sol",
      instructions: "sys",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "c1", name: "ls", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "a b" },
      ],
      tools: [{ type: "function", name: "ls", parameters: { type: "object", properties: {} } }],
    });
    expect(chat.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    const back = chatToResponses(chat);
    expect(back.instructions).toBe("sys");
    expect((back.input as { type: string }[]).map((i) => i.type)).toEqual(["message", "function_call", "function_call_output"]);
    expect(back.store).toBe(false);
  });

  it("decodes Codex SSE and re-encodes for a Responses client", () => {
    const st = newResponsesDecodeState("gpt-6-sol");
    const events = [
      { type: "response.created", response: { id: "resp_1", model: "gpt-6-sol" } },
      { type: "response.output_item.added", item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "ls" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"a":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: "1}" },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc_1", arguments: '{"a":1}' } },
      { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 4, input_tokens_details: { cached_tokens: 1 } } } },
    ];
    const chunks = events.flatMap((e) => decodeResponsesEvent(e, st));
    const obj = completionFromChunks(chunks, "x") as { choices: { message: { tool_calls: { function: { arguments: string } }[] }; finish_reason: string }[] };
    expect(obj.choices[0].message.tool_calls[0].function.arguments).toBe('{"a":1}');
    expect(obj.choices[0].finish_reason).toBe("tool_calls");
    const enc = newResponsesEncodeState("x");
    const out = chunks.flatMap((c) => encodeResponsesEvents(c, enc));
    expect(out[0].event).toBe("response.created");
    expect(out[out.length - 1].event).toBe("response.completed");
    const completed = out[out.length - 1].data.response as { output: { type: string; arguments?: string }[]; usage: { input_tokens: number } };
    expect(completed.output[0]).toMatchObject({ type: "function_call", arguments: '{"a":1}' });
    expect(completed.usage.input_tokens).toBe(3);
  });
});

describe("gemini", () => {
  it("builds contents, declarations and unique call ids", () => {
    const g = chatToGemini({
      model: "m",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "a" },
        { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c", content: "r1" },
        { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c", content: "r2" },
      ],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object", properties: { x: { type: "string", format: "uri", anyOf: [{ type: "string" }, { type: "null" }] } }, additionalProperties: false } } }],
    });
    expect(g.systemInstruction?.parts[0].text).toBe("sys");
    const ids = g.contents.flatMap((c) => c.parts).map((p) => p.functionCall?.id).filter(Boolean);
    expect(new Set(ids).size).toBe(2);
    const params = g.tools![0].functionDeclarations[0].parameters as { properties: { x: Record<string, unknown> }; additionalProperties?: unknown };
    expect(params.additionalProperties).toBeUndefined();
    expect(params.properties.x.format).toBeUndefined();
    expect(params.properties.x.anyOf).toBeUndefined();
    expect(g.contents[g.contents.length - 1].role).toBe("user");
  });

  it("cleans enum const and type arrays", () => {
    expect(cleanSchema({ type: ["string", "null"], const: 3 })).toMatchObject({ type: "string", enum: ["3"] });
  });

  it("decodes the Antigravity wrapper with usage and function call", () => {
    const st = newGeminiDecodeState("m");
    const chunks = [
      ...decodeGeminiChunk({ response: { candidates: [{ content: { parts: [{ text: "Hi" }] } }] } }, st),
      ...decodeGeminiChunk({ response: { candidates: [{ content: { parts: [{ functionCall: { id: "x", name: "f", args: { a: 1 } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1 } } }, st),
    ];
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe("tool_calls");
    expect(last.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 3, reasoning_tokens: 1 });
  });
});

describe("openai aggregate", () => {
  it("merges streamed deltas into one completion", () => {
    const mk = (delta: ChatChunk["choices"][0]["delta"], finish: ChatChunk["choices"][0]["finish_reason"] = null): ChatChunk => ({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] });
    const obj = completionFromChunks([mk({ role: "assistant" }), mk({ content: "He" }), mk({ content: "llo" }), mk({}, "stop")], "m") as { choices: { message: { content: string } }[] };
    expect(obj.choices[0].message.content).toBe("Hello");
  });
});
