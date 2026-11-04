// ============================================================
// PRAANA — Tool Call Accumulator & Safe JSON Parser
// ============================================================

import type { ToolCall } from "./types.js";

/**
 * Parse tool-call arguments as sent.
 * `clean` is false when the text was not valid JSON and a repair (or the
 * raw-text fallback) was used. Empty text is clean: it is `{}` with no repair.
 */
export function parseToolArguments(raw: string): { args: Record<string, unknown>; clean: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { args: {}, clean: true };

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, clean: true };
    }
    return { args: { value: parsed }, clean: true };
  } catch {
    try {
      let repaired = trimmed;
      const openBraces = (repaired.match(/\{/g) || []).length;
      const closeBraces = (repaired.match(/\}/g) || []).length;
      if (openBraces > closeBraces) {
        const quotes = (repaired.match(/"/g) || []).length;
        if (quotes % 2 !== 0) repaired += '"';
        repaired += "}".repeat(openBraces - closeBraces);
        const parsed = JSON.parse(repaired);
        if (typeof parsed === "object" && parsed !== null) {
          return { args: parsed as Record<string, unknown>, clean: false };
        }
      }
    } catch {
      // Fall through to the raw-text result.
    }
    return { args: { _raw: raw, _parseError: true }, clean: false };
  }
}

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
      const parsedArgs = parseToolArguments(call.argsBuffer).args;
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

  /**
   * Finalize any remaining unclosed in-flight tool calls.
   * `allowRepair: false` drops calls whose arguments did not parse as sent
   * and reports their ids. The default keeps today's repair behaviour.
   */
  flush(opts?: { allowRepair?: boolean }): { calls: ToolCall[]; droppedIds: string[] } {
    const allowRepair = opts?.allowRepair !== false;
    const calls: ToolCall[] = [];
    const droppedIds: string[] = [];
    for (const [, call] of this.inFlight.entries()) {
      const parsed = parseToolArguments(call.argsBuffer);
      if (!parsed.clean && !allowRepair) {
        droppedIds.push(call.id);
        continue;
      }
      calls.push({
        id: call.id,
        name: call.name,
        args: parsed.args,
        rawArgs: call.argsBuffer,
      });
    }
    this.inFlight.clear();
    return { calls, droppedIds };
  }
}
