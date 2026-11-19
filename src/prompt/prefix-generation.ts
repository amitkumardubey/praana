import type { EventLog } from "../event-log.js";
import { isResetBoundaryEvent } from "../event-log.js";
import { SESSION_START_EPOCH } from "../frozen-summary.js";
import type { Event } from "../types.js";
import { buildToolGeneration, type ToolGeneration, type ToolWireDef } from "./tools.js";

/**
 * Persistence for the exact model-visible prefix: the rendered system frame,
 * the snapshot message and the tool generation. Resume restores these bytes
 * from the log instead of rebuilding them from current files, so the prefix a
 * provider cache saw stays byte-identical.
 *
 * Two different counters exist and must not be confused:
 * - `prefix_generation` (this module) is session-wide. It starts at 1 and
 *   rises by exactly 1 each time a new prefix is written, across `/clear`.
 * - The compaction `generation` in `frozen-summary.ts` is epoch-local and
 *   restarts at 1 in every reset epoch.
 *
 * Storage is verbatim. `EventLog.append` does not redact, so the frame (which
 * holds project rules) and the snapshot are stored exactly as built. Whether
 * the model-visible prefix and this stored copy are sanitized, and if so
 * identically, is a decision for the code that wires this in, not for this
 * persistence layer.
 *
 * Not called from production code yet. When the cutover wires it in, the
 * prefix generation and a compaction commit that changes the prefix have to
 * be committed together, in this order, in one synchronous section with no
 * model call between the two appends:
 *   1. `restoreFrozenStateFromLog(log)` and `readCurrentPrefixGeneration(...)`:
 *      both must be `ok`, otherwise stop.
 *   2. Build the new frame, snapshot and tool generation.
 *   3. `writePrefixGeneration(log, ...)`.
 *   4. `log.append(buildCommitEvent(...))` for the compaction commit, once
 *      `buildCommitEvent` can carry the prefix.
 * Two appends are not atomic. A crash between 3 and 4 leaves a newer prefix
 * generation with the older compaction state; the reader accepts that log, so
 * the caller must treat "prefix generation newer than the last commit" as a
 * state to reconcile on resume, not as corruption.
 */
export const PREFIX_FORMAT_VERSION = "prompt-v1";
export const PREFIX_GENERATION_KIND = "prefix_generation";

export interface PrefixGenerationInput {
  frame: string;
  snapshot: string;
  tools: ToolGeneration;
}

export interface PrefixGeneration {
  formatVersion: typeof PREFIX_FORMAT_VERSION;
  /** Session-wide, starts at 1, increases by exactly 1 per generation. */
  prefixGeneration: number;
  /** `SESSION_START_EPOCH`, or the id of the reset boundary in effect when it was written. */
  resetEpoch: string;
  frame: string;
  snapshot: string;
  tools: ToolGeneration;
  /**
   * True when this generation was written in an earlier reset epoch than the
   * log's current one. Its frame and tools stay valid after `/clear`, so a
   * resume reproduces the same bytes; the caller decides whether to write a
   * fresh generation for the new epoch.
   */
  carried: boolean;
}

export type PrefixGenerationErrorCode =
  | "unsupported_version"
  | "invalid_payload"
  | "non_monotonic_generation"
  | "invalid_epoch"
  | "tool_generation_mismatch";

export interface PrefixGenerationError {
  code: PrefixGenerationErrorCode;
  /** Position of the offending event in the log passed to the reader. */
  eventIndex: number;
  message: string;
}

export type PrefixGenerationRead =
  | { ok: true; generation: PrefixGeneration | null }
  | { ok: false; error: PrefixGenerationError };

const PAYLOAD_KEYS = ["format_version", "prefix_generation", "reset_epoch", "frame", "snapshot", "tool_generation"];
const TOOL_GENERATION_KEYS = ["id", "tools", "capabilityChoices"];
const TOOL_KEYS = ["name", "description", "parameters"];

function fail(code: PrefixGenerationErrorCode, eventIndex: number, message: string): { ok: false; error: PrefixGenerationError } {
  return { ok: false, error: { code, eventIndex, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

function parseToolGeneration(value: unknown): ToolGeneration | null {
  if (!isPlainObject(value) || !hasExactKeys(value, TOOL_GENERATION_KEYS)) return null;
  if (typeof value.id !== "string" || !Array.isArray(value.tools) || !isPlainObject(value.capabilityChoices)) return null;
  for (const tool of value.tools) {
    if (!isPlainObject(tool) || !hasExactKeys(tool, TOOL_KEYS)) return null;
    if (typeof tool.name !== "string" || typeof tool.description !== "string" || !isPlainObject(tool.parameters)) return null;
  }
  return value as unknown as ToolGeneration;
}

/**
 * Latest prefix generation in the log, read from raw events (internal kinds
 * included; use `log.readAll({ includeInternal: true })`). Every prefix event
 * is validated, not only the last one, and an invalid one is never skipped.
 * With no prefix event the result is `{ ok: true, generation: null }`.
 *
 * Selection rule: the latest event in log order wins, whichever reset epoch
 * wrote it. After `/clear` the previous generation is therefore still returned,
 * flagged `carried`, so resume reproduces the same frame, snapshot and tools.
 */
export function readCurrentPrefixGeneration(events: readonly Event[]): PrefixGenerationRead {
  let epoch = SESSION_START_EPOCH;
  let previous = 0;
  let latest: PrefixGeneration | null = null;

  for (const [index, event] of events.entries()) {
    if (isResetBoundaryEvent(event)) {
      epoch = event.event_id;
      continue;
    }
    if (event.kind !== PREFIX_GENERATION_KIND) continue;

    const payload: unknown = event.payload;
    if (!isPlainObject(payload) || !hasExactKeys(payload, PAYLOAD_KEYS)) {
      return fail("invalid_payload", index, "prefix generation payload has missing or unexpected fields");
    }
    if (typeof payload.format_version !== "string") {
      return fail("invalid_payload", index, "format_version must be a string");
    }
    if (payload.format_version !== PREFIX_FORMAT_VERSION) {
      return fail("unsupported_version", index, `unsupported prefix format ${JSON.stringify(payload.format_version)}`);
    }
    const generation = payload.prefix_generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
      return fail("invalid_payload", index, "prefix_generation must be a positive integer");
    }
    if (typeof payload.reset_epoch !== "string" || payload.reset_epoch.length === 0 ||
        typeof payload.frame !== "string" || typeof payload.snapshot !== "string") {
      return fail("invalid_payload", index, "reset_epoch, frame and snapshot must be strings");
    }
    const tools = parseToolGeneration(payload.tool_generation);
    if (!tools) return fail("invalid_payload", index, "tool_generation is malformed");

    if (generation !== previous + 1) {
      return fail("non_monotonic_generation", index, `prefix generation ${generation} does not follow ${previous}`);
    }
    if (payload.reset_epoch !== epoch) {
      return fail("invalid_epoch", index, "reset epoch does not match the log position");
    }

    let rebuilt: ToolGeneration;
    try {
      rebuilt = buildToolGeneration(tools.tools as ToolWireDef[], tools.capabilityChoices);
    } catch {
      return fail("invalid_payload", index, "tool_generation holds tools that cannot be canonicalized");
    }
    if (rebuilt.id !== tools.id || JSON.stringify(rebuilt.tools) !== JSON.stringify(tools.tools) ||
        JSON.stringify(rebuilt.capabilityChoices) !== JSON.stringify(tools.capabilityChoices)) {
      return fail("tool_generation_mismatch", index, "stored tool generation id does not match its tools");
    }

    previous = generation;
    latest = {
      formatVersion: PREFIX_FORMAT_VERSION,
      prefixGeneration: generation,
      resetEpoch: payload.reset_epoch,
      frame: payload.frame,
      snapshot: payload.snapshot,
      tools,
      carried: false,
    };
  }

  // Only the epoch in effect at the end of the log decides `carried`.
  if (latest) latest = { ...latest, carried: latest.resetEpoch !== epoch };
  return { ok: true, generation: latest };
}

/**
 * Appends the next prefix generation as one internal event. The generation
 * number and reset epoch come from the log itself, so a caller cannot skip or
 * repeat a number. Throws if the log already holds an invalid prefix event or
 * if `input.tools` is not a canonical tool generation.
 */
export function writePrefixGeneration(
  log: Pick<EventLog, "readAll" | "append">,
  input: PrefixGenerationInput,
): PrefixGeneration {
  const events = log.readAll({ includeInternal: true });
  const current = readCurrentPrefixGeneration(events);
  if (!current.ok) throw new Error(`Cannot write a prefix generation: ${current.error.message}`);

  const rebuilt = buildToolGeneration(input.tools.tools, input.tools.capabilityChoices);
  if (rebuilt.id !== input.tools.id) throw new Error("Tool generation id does not match its tools");

  let epoch = SESSION_START_EPOCH;
  for (const event of events) if (isResetBoundaryEvent(event)) epoch = event.event_id;

  const prefixGeneration = (current.generation?.prefixGeneration ?? 0) + 1;
  log.append({
    kind: PREFIX_GENERATION_KIND,
    actor: "kernel",
    payload: {
      format_version: PREFIX_FORMAT_VERSION,
      prefix_generation: prefixGeneration,
      reset_epoch: epoch,
      frame: input.frame,
      snapshot: input.snapshot,
      tool_generation: { id: rebuilt.id, tools: rebuilt.tools, capabilityChoices: rebuilt.capabilityChoices },
    },
  });
  return {
    formatVersion: PREFIX_FORMAT_VERSION,
    prefixGeneration,
    resetEpoch: epoch,
    frame: input.frame,
    snapshot: input.snapshot,
    tools: rebuilt,
    carried: false,
  };
}
