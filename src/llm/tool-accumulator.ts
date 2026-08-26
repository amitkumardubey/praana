// ============================================================
// PRAANA — Tool Call Accumulator & Safe JSON Parser
// ============================================================

import type { ToolCall } from "./types.js";

interface InFlightToolCall {
  id: string;
  name: string;
  argsBuffer: string;
}

/**
 * Accumulates streaming delta chunks for tool calls across multiple indices
 * and safely parses their JSON arguments when the tool block ends.
 */
export class ToolCallAccumulator {
  private inFlight = new Map<number | string, InFlightToolCall>();

  /**
   * Process a tool chunk.
   * Returns:
   * - `start`: if this chunk starts a new tool call
   * - `delta`: if this chunk adds argument text
   * - `end`: if this chunk finalizes a tool call
   */
  processChunk(opts: {
    index: number | string;
    id?: string;
    name?: string;
    argsDelta?: string;
    isComplete?: boolean;
  }): {
    started?: { id: string; name: string };
    delta?: { id: string; argsDelta: string };
    ended?: ToolCall;
  } {
    const key = opts.index;
    let call = this.inFlight.get(key);

    let started: { id: string; name: string } | undefined;

    if (!call) {
      const id = opts.id || `call_${Math.random().toString(36).slice(2, 10)}`;
      const name = opts.name || "";
      call = { id, name, argsBuffer: "" };
      this.inFlight.set(key, call);
      started = { id, name };
    } else {
      if (opts.id && !call.id) call.id = opts.id;
      if (opts.name && !call.name) call.name = opts.name;
    }

    let delta: { id: string; argsDelta: string } | undefined;

    if (opts.argsDelta) {
      call.argsBuffer += opts.argsDelta;
      delta = { id: call.id, argsDelta: opts.argsDelta };
    }

    let ended: ToolCall | undefined;

    if (opts.isComplete) {
      const parsedArgs = this.safeParseJson(call.argsBuffer);
      ended = {
        id: call.id,
        name: call.name,
        args: parsedArgs,
        rawArgs: call.argsBuffer,
      };
      this.inFlight.delete(key);
    }

    return { started, delta, ended };
  }

  /** Finalize any remaining unclosed in-flight tool calls. */
  flush(): ToolCall[] {
    const completed: ToolCall[] = [];
    for (const [, call] of this.inFlight.entries()) {
      const parsedArgs = this.safeParseJson(call.argsBuffer);
      completed.push({
        id: call.id,
        name: call.name,
        args: parsedArgs,
        rawArgs: call.argsBuffer,
      });
    }
    this.inFlight.clear();
    return completed;
  }

  /**
   * Robust JSON parser with fallback repair for common LLM truncation artifacts.
   */
  private safeParseJson(raw: string): Record<string, unknown> {
    const trimmed = raw.trim();
    if (!trimmed) return {};

    // 1. Try standard JSON parse
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      // 2. Attempt lightweight structural repair (unclosed quotes, brackets)
      try {
        let repaired = trimmed;
        // Count open vs close braces
        const openBraces = (repaired.match(/\{/g) || []).length;
        const closeBraces = (repaired.match(/\}/g) || []).length;
        if (openBraces > closeBraces) {
          // If trailing quote is open
          const quotes = (repaired.match(/"/g) || []).length;
          if (quotes % 2 !== 0) repaired += '"';
          repaired += "}".repeat(openBraces - closeBraces);
          const parsed = JSON.parse(repaired);
          if (typeof parsed === "object" && parsed !== null) {
            return parsed as Record<string, unknown>;
          }
        }
      } catch {
        // Return raw text wrapped in error object
      }
      return { _raw: raw, _parseError: true };
    }
  }
}
