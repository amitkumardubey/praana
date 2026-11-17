/**
 * Deterministic secret redaction for tool results and logged tool-call args (#579).
 */

import { types } from "node:util";
import { redactUrlsInText } from "./url-query.js";

const MAX_DEPTH = 8;
const MAX_NODES = 100_000;
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
  readonly source: Record<string, unknown>;
  readonly target: JsonContainer;
  readonly keys: string[] | null;
  readonly length: number;
  readonly suffixes: Map<string, number>;
  cursor: number;
}

function setOwn(container: JsonContainer, key: string, value: JsonValue): void {
  Object.defineProperty(container, key, { value, enumerable: true, writable: true, configurable: true });
}

function uniqueKey(frame: JsonFrame, base: string): string {
  let suffix = frame.suffixes.get(base) ?? 1;
  let key = base;
  while (Object.hasOwn(frame.target, key)) key = `${base}#${++suffix}`;
  frame.suffixes.set(base, suffix);
  return key;
}

function binaryPlaceholder(value: unknown): string | undefined {
  let prototype: object;
  if (types.isTypedArray(value)) prototype = Object.getPrototypeOf(Uint8Array.prototype);
  else if (types.isDataView(value)) prototype = DataView.prototype;
  else if (types.isArrayBuffer(value)) prototype = ArrayBuffer.prototype;
  else if (types.isSharedArrayBuffer(value)) prototype = SharedArrayBuffer.prototype;
  else return undefined;
  // Intrinsic getters read the byte count, not an overridable instance property.
  const getter = Object.getOwnPropertyDescriptor(prototype, "byteLength")!.get!;
  return `[binary: ${getter.call(value)} bytes]`;
}

/**
 * Non-strict redaction walks the JSON projection in one iterative stack. Call
 * toJSON once per value with its original JSON key (root: ""); then unbox JSON
 * primitives, omit functions/symbols/undefined in objects, and use null in arrays.
 * Arrays read indices through length; every other object (including classes,
 * Maps/Sets and Errors) reads only own enumerable string keys, never entries or
 * hidden fields. Redact both string leaves and keys; suffix colliding keys in
 * traversal order. Write only own configurable data properties on fresh copies.
 *
 * Deliberate JSON differences: binary values become byte-count strings BEFORE
 * toJSON (also if returned by it); BigInts become redacted decimal strings;
 * an object that is its own ancestor becomes [REDACTED:cycle]. Cycle detection
 * tracks the current ancestor path only, so a shared reference that is not an
 * ancestor of itself is copied each time, as JSON.stringify would write it.
 * Getters, toJSON and proxy failures replace only the affected value. No input
 * identity, prototype, accessor or callable is retained in the plain JSON output.
 *
 * MAX_NODES bounds traversal only: the root and every property/index slot visited
 * count as one node. When it runs out, every open container keeps its type and
 * the entries already copied, and the remaining entries are cut (no entry is
 * invented and no container becomes a string). Strings are never dropped for
 * size: every string leaf and key is scanned in full by the linear redactString.
 * This bounds our traversal, not execution of user hooks or key enumeration.
 */
function redactJsonProjection(value: unknown): JsonValue | undefined {
  // Containers on the current path only: added when opened, removed when finished.
  const ancestors = new WeakSet<object>();
  const frames: JsonFrame[] = [];
  let nodes = 1;

  const seed = (child: unknown, key: string): JsonValue | undefined => {
    let binary = binaryPlaceholder(child);
    if (binary !== undefined) return binary;
    if (child !== null && (typeof child === "object" || typeof child === "function" || typeof child === "bigint")) {
      const toJSON = (child as { toJSON?: unknown }).toJSON;
      // Use the intrinsic Call, never an input-owned toJSON.call/apply property.
      if (typeof toJSON === "function") child = Function.prototype.call.call(toJSON, child, key);
    }
    binary = binaryPlaceholder(child);
    if (binary !== undefined) return binary;
    if (types.isNumberObject(child)) child = +(child as number);
    else if (types.isStringObject(child)) child = `${child as string}`;
    else if (types.isBooleanObject(child)) child = Boolean.prototype.valueOf.call(child);
    else if (types.isBigIntObject(child)) child = BigInt.prototype.valueOf.call(child);

    if (typeof child === "string") return redactString(child);
    if (typeof child === "bigint") return redactString(String(child));
    if (typeof child === "number") return Number.isFinite(child) ? (child === 0 ? 0 : child) : null;
    if (typeof child === "boolean" || child === null) return child;
    if (typeof child !== "object") return undefined;
    if (ancestors.has(child)) return PLACEHOLDER("cycle");

    const isArray = Array.isArray(child);
    const source = child as Record<string, unknown>;
    const keys = isArray ? null : Object.keys(child);
    // Unary + uses JSON's ToNumber semantics (unlike Number(), rejects BigInt).
    const length = isArray
      ? Math.min(Math.max(Math.floor(+(source.length as number)) || 0, 0), Number.MAX_SAFE_INTEGER)
      : keys!.length;
    const target: JsonContainer = isArray ? [] : {};
    ancestors.add(child);
    frames.push({ source, target, keys, length, suffixes: new Map(), cursor: 0 });
    return target;
  };

  const root = seed(value, "");
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    if (frame.cursor >= frame.length) {
      frames.pop();
      ancestors.delete(frame.source);
      continue;
    }
    // Out of budget: every open container keeps what it has and the rest is cut.
    if (nodes >= MAX_NODES) break;
    nodes++;
    const index = frame.cursor++;
    const key = frame.keys === null ? String(index) : frame.keys[index]!;
    let outputKey: string | undefined;
    try {
      let copied: JsonValue | undefined;
      try {
        copied = seed(frame.source[key], key);
      } catch {
        copied = PLACEHOLDER("redaction-error");
      }
      if (copied === undefined && frame.keys !== null) continue;
      outputKey = frame.keys === null ? key : uniqueKey(frame, redactString(key));
      setOwn(frame.target, outputKey, copied === undefined ? null : copied);
    } catch {
      // A failed key redaction/write cannot abort siblings or write a prototype.
      try {
        outputKey ??= frame.keys === null ? key : uniqueKey(frame, PLACEHOLDER("redaction-error"));
        setOwn(frame.target, outputKey, PLACEHOLDER("redaction-error"));
      } catch {
        // Even a failed fallback write is isolated to this property.
      }
    }
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

export function redactSecrets(value: unknown): JsonValue {
  try {
    const result = redactJsonProjection(value);
    if (typeof value === "string") return result === undefined ? PLACEHOLDER("redaction-error") : result;
    if (result !== null && typeof result === "object") return result;
    return { error: result === undefined ? PLACEHOLDER("redaction-error") : result };
  } catch {
    // Last-resort failure must never return the original input.
    if (typeof value === "string") return PLACEHOLDER("redaction-error");
    return { error: PLACEHOLDER("redaction-error") };
  }
}
