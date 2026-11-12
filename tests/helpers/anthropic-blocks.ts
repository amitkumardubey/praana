import type { AssistantMessage } from "../../src/llm/types.js";

export function anthropicSse(frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

export const signedBlockFrames = [
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "first ", signature: "sig-" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought\n" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "one" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque+redacted/==" } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "text", text: "Before " } },
  { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "tool.\n" } },
  { type: "content_block_stop", index: 2 },
  { type: "content_block_start", index: 3, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 3, delta: { type: "thinking_delta", thinking: "second thought" } },
  { type: "content_block_delta", index: 3, delta: { type: "signature_delta", signature: "sig-" } },
  { type: "content_block_delta", index: 3, delta: { type: "signature_delta", signature: "two" } },
  { type: "content_block_stop", index: 3 },
  { type: "content_block_start", index: 4, content_block: { type: "tool_use", id: "call-blocks", name: "read_file", input: {} } },
  { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: '{"path":"src/llm/' } },
  { type: "content_block_delta", index: 4, delta: { type: "input_json_delta", partial_json: 'types.ts"}' } },
  { type: "content_block_stop", index: 4 },
  { type: "content_block_start", index: 5, content_block: { type: "text", text: "After tool." } },
  { type: "content_block_stop", index: 5 },
];

export const signedAssistant = {
  role: "assistant",
  content: "Before tool.\nAfter tool.",
  thinking: "first thought\nsecond thought",
  thinkingSignature: "sig-onesig-two",
  toolCalls: [{ id: "call-blocks", name: "read_file", args: { path: "src/llm/types.ts" }, rawArgs: '{"path":"src/llm/types.ts"}' }],
  blocks: [
    { type: "thinking", thinking: "first thought\n", signature: "sig-one" },
    { type: "redacted_thinking", data: "opaque+redacted/==" },
    { type: "text", text: "Before tool.\n" },
    { type: "thinking", thinking: "second thought", signature: "sig-two" },
    { type: "tool_use", id: "call-blocks" },
    { type: "text", text: "After tool." },
  ],
} satisfies AssistantMessage;

export const signedWireBlocks = [
  { type: "thinking", thinking: "first thought\n", signature: "sig-one" },
  { type: "redacted_thinking", data: "opaque+redacted/==" },
  { type: "text", text: "Before tool.\n" },
  { type: "thinking", thinking: "second thought", signature: "sig-two" },
  { type: "tool_use", id: "call-blocks", name: "read_file", input: { path: "src/llm/types.ts" } },
  { type: "text", text: "After tool." },
];
