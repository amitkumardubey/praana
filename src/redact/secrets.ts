/**
 * Deterministic secret redaction for tool results and logged tool-call args (#579).
 */

import { types } from "node:util";
import { getAppLogger } from "../logger.js";
import { redactUrlsInText } from "./url-query.js";

const MAX_DEPTH = 8;
const MAX_NODES = 1_000_000;
/** Deepest container written to the output, so JSON.stringify of a result cannot overflow the stack. */
const MAX_OUTPUT_DEPTH = 256;
const PLACEHOLDER = (kind: string) => `[REDACTED:${kind}]`;

const DETECTORS: Array<{ kind: string; re: RegExp }> = [
  { kind: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { kind: "github-token", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai-key", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g },
  {
    kind: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

const ASSIGNMENT_RE =
  /\b([A-Za-z_]*(?:API_KEY|PASSWORD|PASSWD|SECRET|TOKEN|KEY))\s*[=:]\s*([^\s;]{20,})/gi;

function isHexSha(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/** Skip `process.env.FOO` / other dotted identifiers — not secrets. */
function isCodeIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(value);
}

function redactString(text: string): string {
  let out = text;
  for (const { kind, re } of DETECTORS) {
    re.lastIndex = 0;
    out = out.replace(re, PLACEHOLDER(kind));
  }
  ASSIGNMENT_RE.lastIndex = 0;
  out = out.replace(ASSIGNMENT_RE, (full, name: string, value: string) => {
    if (isHexSha(value) || isUlid(value) || isCodeIdentifier(value)) return full;
    return `${name}=${PLACEHOLDER("key-assignment")}`;
  });
  // After the assignment scan so a short query value is not swallowed with the next parameter.
  return redactUrlsInText(out);
}

function typeName(value: unknown): string {
  if (typeof value === "function") return "function";
  const name = (value as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  return typeof name === "string" && name ? name : "object";
}

type JsonValue = string | number | boolean | null | JsonContainer;
type JsonContainer = { [key: string]: JsonValue } | JsonValue[];

interface JsonFrame {
  /** Object whose entries are read (the toJSON result when there was one). */
  readonly source: Record<string, unknown>;
  /** Object or function before toJSON, tracked with `source` as an ancestor (null for a BigInt). */
  readonly original: object | null;
  readonly target: JsonContainer;
  readonly keys: string[] | null;
  readonly length: number;
  /** Created on the first key collision in this container. */
  suffixes: Map<string, number> | null;
  cursor: number;
}

/**
 * Append to a fresh copy. Arrays take pushes (entries are never skipped, so the
 * index equals the push order); objects take plain assignment, except `__proto__`,
 * which must be defined as an own property instead of setting the prototype.
 */
function setOwn(container: JsonContainer, key: string, value: JsonValue): void {
  if (Array.isArray(container)) container.push(value);
  else if (key === "__proto__") Object.defineProperty(container, key, { value, enumerable: true, writable: true, configurable: true });
  else container[key] = value;
}

function uniqueKey(frame: JsonFrame, base: string): string {
  if (!Object.hasOwn(frame.target, base)) return base;
  const suffixes = (frame.suffixes ??= new Map());
  let suffix = suffixes.get(base) ?? 1;
  let key = base;
  while (Object.hasOwn(frame.target, key)) key = `${base}#${++suffix}`;
  suffixes.set(base, suffix);
  return key;
}

/**
 * Error projection keys: `name` and `message`, then `cause` and `errors`
 * (AggregateError) when present as own properties although they are
 * non-enumerable, then the remaining own enumerable properties. JSON.stringify
 * writes `{}` for an Error; diagnostics matter more here. Each value is walked and
 * redacted like any other value. `stack` is never copied, even when enumerable.
 */
function errorKeys(error: object): string[] {
  const keys = ["name", "message"];
  for (const key of ["cause", "errors"]) if (Object.hasOwn(error, key)) keys.push(key);
  for (const key of Object.keys(error)) if (!keys.includes(key) && key !== "stack") keys.push(key);
  return keys;
}

/**
 * Failure report for a walk: a debug log line carrying the error message (never
 * the value), written at most once per walk so repeated placeholders can be
 * diagnosed without flooding the log. The message is redacted before logging.
 */
function createFailureReporter(): (error: unknown) => void {
  let reported = false;
  return (error) => {
    if (reported) return;
    reported = true;
    let message: string;
    try {
      message = redactString((error instanceof Error ? error.message : String(error)).slice(0, 500));
    } catch {
      message = PLACEHOLDER("redaction-error");
    }
    getAppLogger().child("tool").debug("Secret redaction replaced a value", { details: { error: message } });
  };
}

// Intrinsic byteLength getters, read once so later patching of prototypes is not trusted.
const byteLengthOf = (prototype: object | undefined): ((this: unknown) => number) | undefined =>
  prototype === undefined ? undefined : Object.getOwnPropertyDescriptor(prototype, "byteLength")?.get as ((this: unknown) => number) | undefined;
const TYPED_ARRAY_BYTES = byteLengthOf(Object.getPrototypeOf(Uint8Array.prototype));
const DATA_VIEW_BYTES = byteLengthOf(DataView.prototype);
const ARRAY_BUFFER_BYTES = byteLengthOf(ArrayBuffer.prototype);
const SHARED_BUFFER_BYTES = byteLengthOf(typeof SharedArrayBuffer === "undefined" ? undefined : SharedArrayBuffer.prototype);

function binaryPlaceholder(value: unknown): string | undefined {
  let getter: ((this: unknown) => number) | undefined;
  if (types.isTypedArray(value)) getter = TYPED_ARRAY_BYTES;
  else if (types.isDataView(value)) getter = DATA_VIEW_BYTES;
  else if (types.isArrayBuffer(value)) getter = ARRAY_BUFFER_BYTES;
  else if (types.isSharedArrayBuffer(value)) getter = SHARED_BUFFER_BYTES;
  else return undefined;
  return `[binary: ${getter!.call(value)} bytes]`;
}

function finiteNumber(value: number): number | null {
  return Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
}

/**
 * Non-strict redaction walks the JSON projection of the root in one iterative stack. Call
 * toJSON once per value with its original JSON key (root: ""); then unbox JSON
 * primitives, omit functions/symbols/undefined in objects, and use null in arrays.
 * Arrays read indices through length; every other object (including classes,
 * Maps/Sets and Errors) reads only own enumerable string keys, never entries or
 * hidden fields. Redact both string leaves and keys; suffix colliding keys in
 * traversal order. Write only own data properties on fresh copies.
 *
 * Map and Set contents are not emitted: like JSON.stringify, a Map or Set projects
 * as `{}` plus its own enumerable properties, so no secret inside one can leak.
 *
 * Scalars follow JSON everywhere, root included: NaN and the infinities become
 * null, -0 becomes 0, BigInts become redacted decimal strings (or their toJSON).
 * Other deliberate JSON differences: binary values become byte-count strings BEFORE
 * toJSON (also if returned by it);
 * a value that is its own ancestor becomes [REDACTED:cycle]. Cycle detection
 * tracks the current ancestor path only, and both the value before toJSON and the
 * object toJSON returned, so a shared reference that is not an ancestor of itself
 * is copied each time, as JSON.stringify would write it, while a toJSON that
 * returns a structure pointing back at its owner is cut at the first repeat.
 * Native Errors project as { name, message } plus own `cause`, AggregateError
 * `errors` and own enumerable properties, never `stack` (JSON.stringify writes {}).
 * Getters, toJSON and proxy failures replace only the affected value (the first
 * such failure of a walk is logged at debug level, message only); only a
 * failure of the root itself or an unrecoverable error escapes to the caller.
 * No input identity, prototype, accessor or callable is retained in the plain JSON output.
 *
 * Output containers nest at most MAX_OUTPUT_DEPTH deep; a deeper container becomes
 * [REDACTED:depth-limit] so the result can always be serialized.
 *
 * MAX_NODES bounds traversal only (exponential shared-reference DAGs, endless
 * toJSON chains); the root and every property/index slot visited count as one node.
 * When it runs out, each container still open keeps its type and the entries
 * already copied and gets an explicit marker: an array a final element
 * `{ "[REDACTED:node-budget]": true }`, an object that same key. Before
 * stopping, an open object also copies its remaining scalar entries (strings
 * redacted, numbers, booleans, null, BigInts) so shallow fields such as `ok` or
 * `total` survive; nested containers not yet opened and the rest of an open
 * array are dropped. Strings are never dropped for size: every string leaf and key
 * is scanned in full by the linear redactString, and each distinct key once per walk.
 * This bounds our traversal, not execution of user hooks or key enumeration.
 */
function redactJsonProjection(value: unknown): JsonValue | undefined {
  // Containers on the current path only: added when opened, removed when finished.
  const ancestors = new WeakSet<object>();
  const frames: JsonFrame[] = [];
  const keyCache = new Map<string, string>();
  const report = createFailureReporter();
  let nodes = 1;

  /** The one guard around redactString for keys and string values: failure gives the placeholder. */
  const redactText = (text: string): string => {
    try {
      return redactString(text);
    } catch (error) {
      report(error);
      return PLACEHOLDER("redaction-error");
    }
  };

  const redactKey = (key: string): string => {
    let redacted = keyCache.get(key);
    if (redacted === undefined) {
      redacted = redactText(key);
      keyCache.set(key, redacted);
    }
    return redacted;
  };

  const seed = (input: unknown, key: string): JsonValue | undefined => {
    // Primitives other than BigInt have no toJSON, binary or box handling.
    if (input === null) return null;
    const type = typeof input;
    if (type === "string") return redactText(input as string);
    if (type === "number") return finiteNumber(input as number);
    if (type === "boolean") return input as boolean;
    if (type === "undefined" || type === "symbol") return undefined;
    if (type !== "bigint" && ancestors.has(input as object)) return PLACEHOLDER("cycle");

    let child = input;
    let binary = binaryPlaceholder(child);
    if (binary !== undefined) return binary;
    const toJSON = (child as { toJSON?: unknown }).toJSON;
    // Use the intrinsic Call, never an input-owned toJSON.call/apply property.
    if (typeof toJSON === "function") child = Function.prototype.call.call(toJSON, child, key);
    binary = binaryPlaceholder(child);
    if (binary !== undefined) return binary;
    if (types.isNumberObject(child)) child = +(child as number);
    else if (types.isStringObject(child)) child = `${child as string}`;
    else if (types.isBooleanObject(child)) child = Boolean.prototype.valueOf.call(child);
    else if (types.isBigIntObject(child)) child = BigInt.prototype.valueOf.call(child);

    if (typeof child === "string") return redactText(child);
    if (typeof child === "bigint") return redactText(String(child));
    if (typeof child === "number") return finiteNumber(child);
    if (typeof child === "boolean" || child === null) return child;
    if (typeof child !== "object") return undefined;
    if (child !== input && ancestors.has(child)) return PLACEHOLDER("cycle");
    if (frames.length >= MAX_OUTPUT_DEPTH) return PLACEHOLDER("depth-limit");

    const isArray = Array.isArray(child);
    const source = child as Record<string, unknown>;
    const keys = isArray ? null : types.isNativeError(child) ? errorKeys(child) : Object.keys(child);
    // Unary + uses JSON's ToNumber semantics (unlike Number(), rejects BigInt).
    const length = isArray
      ? Math.min(Math.max(Math.floor(+(source.length as number)) || 0, 0), Number.MAX_SAFE_INTEGER)
      : keys!.length;
    const target: JsonContainer = isArray ? [] : {};
    // A BigInt input has no identity to track; only objects and functions do.
    const original = typeof input === "object" || typeof input === "function" ? (input as object) : null;
    ancestors.add(child);
    if (original !== null) ancestors.add(original);
    frames.push({ source, original, target, keys, length, suffixes: null, cursor: 0 });
    return target;
  };

  /** Budget exhausted: mark every container that still has entries and keep its scalar fields. */
  const closeOpenFrames = (): void => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i]!;
      if (frame.cursor >= frame.length) continue;
      if (frame.keys === null) {
        // Out-of-band marker: an object, so it cannot be mistaken for an array element of data.
        setOwn(frame.target, "", { [PLACEHOLDER("node-budget")]: true });
        continue;
      }
      for (; frame.cursor < frame.length; frame.cursor++) {
        const key = frame.keys[frame.cursor]!;
        let copied: JsonValue | undefined;
        try {
          const raw = frame.source[key];
          const type = typeof raw;
          const scalar = raw === null || type === "string" || type === "number" || type === "boolean" || type === "bigint";
          copied = scalar ? seed(raw, key) : undefined;
        } catch (error) {
          report(error);
          copied = PLACEHOLDER("redaction-error");
        }
        if (copied !== undefined) setOwn(frame.target, uniqueKey(frame, redactKey(key)), copied);
      }
      setOwn(frame.target, uniqueKey(frame, PLACEHOLDER("node-budget")), true);
    }
  };

  const root = seed(value, "");
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    if (frame.cursor >= frame.length) {
      frames.pop();
      ancestors.delete(frame.source);
      if (frame.original !== null) ancestors.delete(frame.original);
      continue;
    }
    if (nodes >= MAX_NODES) {
      closeOpenFrames();
      break;
    }
    nodes++;
    const index = frame.cursor++;
    const key = frame.keys === null ? String(index) : frame.keys[index]!;
    let copied: JsonValue | undefined;
    try {
      copied = seed(frame.source[key], key);
    } catch (error) {
      // Replaces only this value; siblings are still walked.
      report(error);
      copied = PLACEHOLDER("redaction-error");
    }
    if (copied === undefined && frame.keys !== null) continue;
    const outputKey = frame.keys === null ? key : uniqueKey(frame, redactKey(key));
    setOwn(frame.target, outputKey, copied === undefined ? null : copied);
  }
  return root;
}

type StrictCopy = string | number | boolean | bigint | symbol | null | undefined
  | { [key: string]: StrictCopy } | StrictCopy[];

function walkStrict(value: unknown, depth: number): StrictCopy {
  if (depth >= MAX_DEPTH) throw new Error("Secret redaction depth limit exceeded");
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value.map((item) => walkStrict(item, depth + 1));
  }
  if (typeof value === "function") {
    throw new TypeError("Secret redaction cannot walk a function");
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const copy: Record<string, StrictCopy> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        copy[k] = walkStrict(v, depth + 1);
      }
      return copy;
    }
    // Fails closed: anything else (class instances, Map, Set, Date, typed arrays) is
    // unreadable to this walk, so strict mode refuses it instead of passing it through.
    throw new TypeError(`Secret redaction cannot walk a ${typeName(value)}`);
  }
  // All objects and functions were handled above; only primitives remain.
  return value as StrictCopy;
}

export function redactSecretsStrict<T>(value: T): T {
  return walkStrict(value, 0) as T;
}

/**
 * What a failed redaction returns in place of `value`: the bare placeholder for a
 * string, `{ error: placeholder }` for anything else. Never the input.
 */
export function redactionFailureFor(value: unknown): JsonValue {
  return typeof value === "string" ? PLACEHOLDER("redaction-error") : { error: PLACEHOLDER("redaction-error") };
}

/**
 * Root contract: the root goes through the same walk and scalar rules as nested
 * values (a string is redacted, NaN/Infinity become null, -0 becomes 0, a BigInt
 * its decimal string or toJSON). Only `undefined` returns `undefined`. A projection
 * JSON would omit (a function, a symbol, toJSON returning undefined) returns null,
 * never `undefined`: the post-tool-call hook applies a patch by key, but other
 * callers may treat `undefined` as "keep the original". Scalars are never wrapped.
 * Only a walk that throws fails closed (see redactionFailureFor).
 */
export function redactSecrets(value: unknown): JsonValue | undefined {
  try {
    if (value === undefined) return undefined;
    return redactJsonProjection(value) ?? null;
  } catch {
    // Last-resort failure must never return the original input.
    return redactionFailureFor(value);
  }
}
