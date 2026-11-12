import { buildSummaryInstruction, type SummaryInstructionOptions } from "./frozen-summary.js";
import type { StreamRequest } from "./llm/types.js";

/**
 * Preserve the last-sent prefix, including the entire terminal tool-result batch.
 * No tool choice, transport defaults, output-cap change or cache marker is added.
 */
export function buildSameModelSummaryRequest(
  live: StreamRequest,
  instruction: string | SummaryInstructionOptions,
): StreamRequest {
  return { ...live, messages: [
    ...live.messages,
    { role: "user", content: typeof instruction === "string" ? instruction : buildSummaryInstruction(instruction) },
  ] };
}
