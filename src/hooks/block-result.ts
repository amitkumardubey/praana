/**
 * Map a pre_tool_call block onto the agent-facing tool result (#300).
 */

import type { PreToolCallDispatchResult } from "./types.js";

export function toolResultFromPreBlock(
  pre: Extract<PreToolCallDispatchResult, { action: "block" }>,
): { ok: false; error: string; suggestions?: string[] } {
  return {
    ok: false,
    error: pre.error,
    ...(pre.suggestions?.length ? { suggestions: pre.suggestions } : {}),
  };
}
