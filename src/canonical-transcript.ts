import type { AssistantBlock, AssistantMessage, ConversationMessage } from "./llm/types.js";
import type { EventLog } from "./event-log.js";
import { redactSecrets } from "./redact/secrets.js";
import type { Event } from "./types.js";
import { eventsAfterResetBoundary } from "./event-log.js";

export const CANONICAL_TRANSCRIPT_VERSION = 1;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export interface CanonicalToolCall {
  id: string;
  name: string;
  args: JsonObject;
  rawArgs?: string;
}
interface RecordBase<K extends string, M> {
  formatVersion: typeof CANONICAL_TRANSCRIPT_VERSION;
  kind: K;
  turnId: number;
  message: M;
}
/** One assistant step, including its complete parallel call batch. Arguments are caller-sanitized. */
export type CanonicalAssistantRecord = RecordBase<"assistant", {
  text: string;
  thinking?: string;
  thinkingSignature?: string;
  blocks?: AssistantBlock[];
  toolCalls?: CanonicalToolCall[];
}>;
export type CanonicalToolResultRecord = RecordBase<"tool_result", {
  callId: string;
  toolName: string;
  isError: boolean;
  text: string;
}>;
export type CanonicalRecord =
  | RecordBase<"user_input" | "wrap_up", { text: string }>
  | CanonicalAssistantRecord
  | CanonicalToolResultRecord
  | RecordBase<"notice" | "snapshot" | "summary", JsonObject>;

export type CanonicalTranscriptErrorCode =
  | "invalid_record" | "unsupported_version" | "invalid_turn" | "invalid_blocks"
  | "orphan_result" | "duplicate_result" | "duplicate_call_id"
  | "interrupted_batch" | "tool_name_mismatch";

export class CanonicalTranscriptError extends Error {
  constructor(public readonly code: CanonicalTranscriptErrorCode, public readonly recordIndex: number, detail: string) {
    super(`Canonical transcript record ${recordIndex}: ${detail}`);
    this.name = "CanonicalTranscriptError";
  }
}

export const INTERRUPTED_TOOL_RESULT = Object.freeze({
  text: "Tool execution was interrupted before a result was recorded.",
  isError: true,
} as const);

function fail(code: CanonicalTranscriptErrorCode, index: number, detail: string): never {
  throw new CanonicalTranscriptError(code, index, detail);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Reject lossy JSON values, custom objects and cycles rather than silently rewriting them. */
function isJson(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && !object(value)) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Object.keys(value).length === value.length && Array.from(value).every((item) => isJson(item, ancestors, depth + 1))
    : Object.values(value).every((item) => isJson(item, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function optionalString(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || typeof value[key] === "string";
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isToolCall(value: unknown): boolean {
  return object(value) && onlyKeys(value, ["id", "name", "args", "rawArgs"]) &&
    nonempty(value.id) && nonempty(value.name) && object(value.args) && optionalString(value, "rawArgs");
}

function isBlock(value: unknown): boolean {
  if (!object(value)) return false;
  switch (value.type) {
    case "thinking":
      return onlyKeys(value, ["type", "thinking", "signature"]) &&
        typeof value.thinking === "string" && typeof value.signature === "string";
    case "redacted_thinking":
      return onlyKeys(value, ["type", "data"]) && typeof value.data === "string";
    case "text":
      return onlyKeys(value, ["type", "text"]) && typeof value.text === "string";
    case "tool_use":
      return onlyKeys(value, ["type", "id"]) && nonempty(value.id);
    default:
      return false;
  }
}

function assertRecord(value: unknown, index: number): asserts value is CanonicalRecord {
  if (!object(value)) fail("invalid_record", index, "expected a record object");
  if (value.formatVersion !== CANONICAL_TRANSCRIPT_VERSION) {
    fail("unsupported_version", index, "unsupported format version");
  }
  if (!isJson(value) || !onlyKeys(value, ["formatVersion", "kind", "turnId", "message"]) ||
      !Number.isSafeInteger(value.turnId) || (value.turnId as number) < 1 || !object(value.message)) {
    fail("invalid_record", index, "expected JSON-only payload and positive safe-integer turn id");
  }
  const message = value.message;
  let valid: boolean;
  switch (value.kind) {
    case "user_input":
    case "wrap_up":
      valid = onlyKeys(message, ["text"]) && typeof message.text === "string";
      break;
    case "tool_result":
      valid = onlyKeys(message, ["callId", "toolName", "isError", "text"]) &&
        nonempty(message.callId) && nonempty(message.toolName) &&
        typeof message.isError === "boolean" && typeof message.text === "string";
      break;
    case "assistant": {
      valid = onlyKeys(message, ["text", "thinking", "thinkingSignature", "blocks", "toolCalls"]) &&
        typeof message.text === "string" && optionalString(message, "thinking") && optionalString(message, "thinkingSignature") &&
        (!("toolCalls" in message) || (Array.isArray(message.toolCalls) && message.toolCalls.every(isToolCall))) &&
        (!("blocks" in message) || (Array.isArray(message.blocks) && message.blocks.every(isBlock)));
      if (valid && Array.isArray(message.blocks)) {
        const calls = (message.toolCalls ?? []) as CanonicalToolCall[];
        const ids = new Set(calls.map((call) => call.id));
        const references = new Set<string>();
        for (const block of message.blocks as AssistantBlock[]) {
          if (block.type !== "tool_use") continue;
          if (!ids.has(block.id) || references.has(block.id)) {
            fail("invalid_blocks", index, "tool blocks must reference each call exactly once");
          }
          references.add(block.id);
        }
        if (references.size !== ids.size) fail("invalid_blocks", index, "ordered blocks omit tool calls");
      }
      break;
    }
    case "notice":
    case "snapshot":
    case "summary":
      valid = true;
      break;
    default:
      valid = false;
  }
  if (!valid) fail("invalid_record", index, "invalid kind or message payload");
}

/**
 * Current reset epoch for replay. Results stranded before its first input are hidden.
 * Pass raw events from EventLog.readAll({ includeCanonical: true }); the default
 * read filters canonical events and would silently return an empty transcript.
 */
export function readCanonicalRecords(events: readonly Event[]): CanonicalRecord[] {
  let seenInput = false;
  return readFullSessionCanonicalRecords(eventsAfterResetBoundary([...events])).filter((record) => {
    if (record.kind === "user_input") seenInput = true;
    return seenInput || record.kind !== "tool_result";
  });
}

/**
 * All epochs, with schema validation. Use for session-wide turn-id allocation.
 * Pass raw events from EventLog.readAll({ includeCanonical: true }); the default
 * read filters canonical events and would silently return an empty transcript.
 */
export function readFullSessionCanonicalRecords(events: readonly Event[]): CanonicalRecord[] {
  const records: CanonicalRecord[] = [];
  for (const event of events) {
    if (event.kind !== "canonical_message") continue;
    const record = event.payload;
    assertRecord(record, records.length);
    records.push(record);
  }
  return records;
}

/** One-based session sequence. Pass the full session's records, not just the visible epoch. */
export function nextCanonicalTurnId(records: readonly CanonicalRecord[]): number {
  let last = 0;
  for (const [index, record] of records.entries()) {
    assertRecord(record, index);
    if (record.kind !== "user_input") continue;
    if (record.turnId <= last) fail("invalid_turn", index, "user_input turn ids must increase");
    last = record.turnId;
  }
  if (last === Number.MAX_SAFE_INTEGER) fail("invalid_turn", records.length, "turn id sequence exhausted");
  return last + 1;
}

function emitResult(record: CanonicalToolResultRecord): ConversationMessage {
  const message = record.message;
  return { role: "tool_result", toolCallId: message.callId, toolName: message.toolName, isError: message.isError, result: message.text };
}

/** Stateful strict validator, shared by replay and the append path. */
export class CanonicalValidator {
  private calls = new Set<string>();
  private results = new Set<string>();
  private pending = new Map<string, { call: CanonicalToolCall; turnId: number }>();
  private turnId: number | undefined;
  private index = 0;

  accept(record: unknown): void {
    const index = this.index;
    assertRecord(record, index);
    if (record.kind === "tool_result") {
      const { callId, toolName } = record.message;
      if (!this.calls.has(callId)) fail("orphan_result", index, `no earlier call ${callId}`);
      if (this.results.has(callId)) fail("duplicate_result", index, `result already recorded for ${callId}`);
      const batch = this.pending.get(callId);
      if (!batch) fail("orphan_result", index, `no pending batch for ${callId}`);
      if (record.turnId !== batch.turnId) fail("invalid_turn", index, "result must use its batch's turn id");
      if (toolName !== batch.call.name) fail("tool_name_mismatch", index, `result tool does not match ${callId}`);
      this.results.add(callId);
      this.pending.delete(callId);
    } else {
      if (this.pending.size) fail("interrupted_batch", index, "only results may follow an incomplete assistant batch");
      if (record.kind === "user_input") {
        if (this.turnId !== undefined && record.turnId <= this.turnId) fail("invalid_turn", index, "user_input turn ids must increase");
      } else if (this.turnId === undefined || record.turnId !== this.turnId) {
        fail("invalid_turn", index, "record must belong to the current user_input turn");
      }
      if (record.kind === "assistant") {
        const newIds = new Set<string>();
        for (const call of record.message.toolCalls ?? []) {
          if (this.calls.has(call.id) || newIds.has(call.id)) fail("duplicate_call_id", index, `call id already used: ${call.id}`);
          newIds.add(call.id);
        }
        for (const call of record.message.toolCalls ?? []) {
          this.calls.add(call.id);
          this.pending.set(call.id, { call, turnId: record.turnId });
        }
      }
      if (record.kind === "user_input") this.turnId = record.turnId;
    }
    this.index++;
  }

  nextTurnId(): number {
    if (this.turnId === Number.MAX_SAFE_INTEGER) fail("invalid_turn", this.index, "turn id sequence exhausted");
    return (this.turnId ?? 0) + 1;
  }

  repairs(): CanonicalToolResultRecord[] {
    return Array.from(this.pending.values(), ({ call, turnId }) => ({
      formatVersion: CANONICAL_TRANSCRIPT_VERSION, kind: "tool_result", turnId,
      message: { callId: call.id, toolName: call.name, ...INTERRUPTED_TOOL_RESULT },
    }));
  }
}

function scan(records: readonly CanonicalRecord[]): {
  messages: ConversationMessage[];
  repairs: CanonicalToolResultRecord[];
} {
  const messages: ConversationMessage[] = [];
  const validator = new CanonicalValidator();
  for (const record of records) {
    validator.accept(record);
    switch (record.kind) {
      case "tool_result": messages.push(emitResult(record)); break;
      case "user_input":
      case "wrap_up": messages.push({ role: "user", content: record.message.text }); break;
      case "assistant": {
        const message = record.message;
        messages.push({
          role: "assistant", content: message.text,
          ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
          ...(message.thinkingSignature !== undefined ? { thinkingSignature: message.thinkingSignature } : {}),
          ...(message.blocks !== undefined ? { blocks: structuredClone(message.blocks) } : {}),
          ...(message.toolCalls !== undefined ? { toolCalls: structuredClone(message.toolCalls) } : {}),
        });
        break;
      }
    }
  }
  return { messages, repairs: validator.repairs() };
}

/** Strict replay. The sole tolerated gap is an incomplete batch at the very end. */
export function emitCanonicalTranscript(records: readonly CanonicalRecord[]): ConversationMessage[] {
  const { messages, repairs } = scan(records);
  return [...messages, ...repairs.map(emitResult)];
}

/**
 * Append only missing terminal results, sequentially. The callback owns persistence;
 * pass its updated durable record list on retry. Failures propagate, including a
 * failure after an append was persisted. No input mutation or tool execution occurs.
 */
export async function repairCanonicalTranscript(
  records: readonly CanonicalRecord[],
  append: (record: CanonicalToolResultRecord) => void | Promise<void>,
): Promise<number> {
  const { repairs } = scan(records);
  for (const record of repairs) await append(record);
  return repairs.length;
}

/**
 * Session-bound, sequential writer. A failed append has an uncertain durable
 * outcome: stop this writer, report the error, and let a fresh writer reread
 * the log. Live model/tool work can continue without trusting in-memory state.
 */
export class CanonicalWriter {
  private validator: CanonicalValidator | undefined;
  private failed = false;

  constructor(
    private readonly log: Pick<EventLog, "readAll" | "append">,
    private readonly onError: (error: unknown, context: { kind: string; turnId?: number }) => void,
  ) {}

  private persist(record: CanonicalRecord): void {
    this.validator!.accept(record);
    this.log.append({ kind: "canonical_message", actor: "kernel", payload: { ...record } });
  }

  private async write(kind: CanonicalRecord["kind"], build: () => CanonicalRecord): Promise<CanonicalRecord | null> {
    if (this.failed) return null;
    let record: CanonicalRecord | undefined;
    try {
      if (!this.validator) {
        const validator = new CanonicalValidator();
        for (const event of this.log.readAll({ includeCanonical: true })) {
          if (event.kind === "canonical_message") validator.accept(event.payload);
        }
        this.validator = validator;
      }
      record = build();
      if (record.kind !== "tool_result") {
        for (const repair of this.validator.repairs()) this.persist(repair);
      }
      this.persist(record);
      return record;
    } catch (error) {
      this.failed = true;
      this.onError(error, { kind, ...(record ? { turnId: record.turnId } : {}) });
      return null;
    }
  }

  async startTurn(text: string): Promise<number | null> {
    const record = await this.write("user_input", () => ({
      formatVersion: CANONICAL_TRANSCRIPT_VERSION, kind: "user_input",
      turnId: this.validator!.nextTurnId(), message: { text },
    }));
    return record?.turnId ?? null;
  }

  async assistant(turnId: number | null, message: AssistantMessage): Promise<void> {
    if (turnId === null) return;
    await this.write("assistant", () => ({
      formatVersion: CANONICAL_TRANSCRIPT_VERSION, kind: "assistant", turnId,
      message: {
        text: typeof message.content === "string" ? message.content :
          (message.content as Array<{ type: string; text?: string }>).filter((part) => part.type === "text").map((part) => part.text ?? "").join(""),
        ...(message.thinking !== undefined ? { thinking: message.thinking } : {}),
        ...(message.thinkingSignature !== undefined ? { thinkingSignature: message.thinkingSignature } : {}),
        ...(message.blocks !== undefined ? { blocks: structuredClone(message.blocks) } : {}),
        ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls.map((call) => {
          const args = redactSecrets(call.args) as JsonObject;
          // Never retain raw input: duplicate JSON keys can conceal secrets.
          return { id: call.id, name: call.name, args, rawArgs: JSON.stringify(args) };
        }) } : {}),
      },
    }));
  }

  async result(turnId: number | null, callId: string, toolName: string, text: string, isError: boolean): Promise<void> {
    if (turnId === null) return;
    await this.write("tool_result", () => ({
      formatVersion: CANONICAL_TRANSCRIPT_VERSION, kind: "tool_result", turnId,
      message: { callId, toolName, text: redactSecrets(text) as string, isError },
    }));
  }

  async wrapUp(turnId: number | null, text: string): Promise<void> {
    if (turnId === null) return;
    await this.write("wrap_up", () => ({
      formatVersion: CANONICAL_TRANSCRIPT_VERSION, kind: "wrap_up", turnId, message: { text },
    }));
  }
}
