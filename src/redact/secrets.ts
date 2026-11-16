/**
 * Deterministic secret redaction for tool results and logged tool-call args (#579).
 */

import { redactUrlsInText } from "./url-query.js";

const MAX_DEPTH = 8;
/** Upper bound on the containers one depth-limit walk may visit. */
const MAX_DEEP_NODES = 100_000;
/** Upper bound on the characters one depth-limit walk may redact. */
const MAX_DEEP_CHARS = 4_194_304;
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

/** A copied container: a plain object or an array, both written by string key. */
type DeepContainer = Record<string, unknown> | unknown[];

/** Values the deep walk can hand back: copied containers and kept primitives. */
type DeepCopy =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | DeepContainer;

/** Primitives that carry no redactable text, so the deep walk keeps them as-is. */
function isKeptPrimitive(
  value: unknown,
): value is number | boolean | bigint | symbol | null | undefined {
  return (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "symbol" ||
    value === undefined
  );
}

interface DeepFrame {
  /** Node being copied; arrays are read through the same string-keyed shape. */
  readonly source: Record<string, unknown>;
  readonly target: DeepContainer;
  readonly keys: string[];
  cursor: number;
}

function setOwn(container: DeepContainer, key: string, value: unknown): void {
  // SAFETY: both branches of the union take string-keyed writes; an array keeps its
  // array-ness because its length is set before any key from `Object.keys` is written.
  (container as Record<string, unknown>)[key] = value;
}

/**
 * Fail closed at the depth limit in non-strict mode: walk the over-limit subtree
 * and redact every string leaf the walk can reach. Redacting the real string
 * leaves means escapes (`\n`, `\t`) never hide a secret from the detectors.
 *
 * The walk is iterative, so a very deep chain cannot overflow the call stack, and
 * it never serializes, so `toJSON` is not consulted and no text is allocated up
 * front. Plain objects and arrays are copied with the same keys/indexes, which
 * keeps the original shape. Whatever the walk cannot read (cycles, class
 * instances, Maps, throwing getters) becomes a placeholder, and both the visited
 * nodes and the redacted characters are budgeted: anything past a budget becomes
 * `[REDACTED:depth-limit]` instead of the original value.
 */
function redactAtDepthLimit(value: unknown): DeepCopy {
  // A string at the limit is a leaf of this walk, so it has to go through the
  // character cap below rather than being scanned whole here.
  if (typeof value === "function") return PLACEHOLDER("unwalkable");
  if (isKeptPrimitive(value)) return value;

  const visited = new WeakSet<object>();
  const frames: DeepFrame[] = [];
  let nodes = 0;
  let chars = 0;

  const redactLeaf = (leaf: string): string => {
    if (chars + leaf.length > MAX_DEEP_CHARS) return PLACEHOLDER("depth-limit");
    chars += leaf.length;
    return redactString(leaf);
  };

  /** Copy a container's own keys, or return the placeholder that replaces it. */
  const open = (node: Record<string, unknown>): DeepFrame | string => {
    if (visited.has(node)) return PLACEHOLDER("cycle");
    if (nodes >= MAX_DEEP_NODES) return PLACEHOLDER("depth-limit");
    let keys: string[];
    let target: DeepContainer;
    try {
      const isArray = Array.isArray(node);
      if (!isArray && Object.getPrototypeOf(node) !== Object.prototype) {
        return PLACEHOLDER("unwalkable");
      }
      keys = Object.keys(node);
      if (isArray) {
        const list: unknown[] = [];
        // Same length, holes preserved: only `keys` is ever written below.
        list.length = node.length;
        target = list;
      } else {
        target = {};
      }
    } catch {
      // Enumeration can fail (e.g. a Proxy); nothing of the node can be trusted.
      return PLACEHOLDER("redaction-error");
    }
    visited.add(node);
    nodes++;
    return { source: node, target, keys, cursor: 0 };
  };

  const seed = (child: unknown, assign: (copied: DeepCopy) => void): void => {
    if (typeof child === "string") {
      assign(redactLeaf(child));
      return;
    }
    if (typeof child === "function") {
      assign(PLACEHOLDER("unwalkable"));
      return;
    }
    if (isKeptPrimitive(child)) {
      assign(child);
      return;
    }
    // SAFETY: `open` re-checks the shape (Array.isArray, then an Object.prototype
    // prototype) before it reads a single key, so the widened view is safe.
    const opened = open(child as Record<string, unknown>);
    if (typeof opened === "string") {
      assign(opened);
      return;
    }
    assign(opened.target);
    frames.push(opened);
  };

  let root: DeepCopy = PLACEHOLDER("depth-limit");
  seed(value, (copied) => {
    root = copied;
  });

  while (frames.length > 0) {
    const frame = frames.at(-1);
    if (frame === undefined) break;
    if (frame.cursor >= frame.keys.length) {
      frames.pop();
      continue;
    }
    const key = frame.keys[frame.cursor++] ?? "";
    const target = frame.target;
    if (nodes >= MAX_DEEP_NODES) {
      // The node budget is spent: do not read what is left, and do not keep it.
      setOwn(target, key, PLACEHOLDER("depth-limit"));
      continue;
    }
    let child: unknown;
    try {
      child = frame.source[key];
    } catch {
      // A property read that throws costs only that value.
      setOwn(target, key, PLACEHOLDER("redaction-error"));
      continue;
    }
    seed(child, (copied) => setOwn(target, key, copied));
  }

  return root;
}

function walk(value: unknown, depth: number, strict = false): unknown {
  if (depth >= MAX_DEPTH) {
    if (strict) throw new Error("Secret redaction depth limit exceeded");
    return redactAtDepthLimit(value);
  }
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, strict));
  }
  if (typeof value === "function") {
    if (strict) throw new TypeError("Secret redaction cannot walk a function");
    return value;
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    // A null prototype holds data exactly like a plain object; only strict mode walks it,
    // so the non-strict redactor keeps returning such values untouched.
    if (prototype === Object.prototype || (strict && prototype === null)) {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        copy[k] = walk(v, depth + 1, strict);
      }
      return copy;
    }
    // Fails closed: anything else (class instances, Map, Set, Date, typed arrays) is
    // unreadable to this walk, so strict mode refuses it instead of passing it through.
    // Known limitation: non-strict mode still returns such values untouched below the
    // depth limit, so a secret held inside a Map/Set/class instance is not redacted.
    if (strict) throw new TypeError(`Secret redaction cannot walk a ${typeName(value)}`);
    return value;
  }
  return value;
}

export function redactSecretsStrict<T>(value: T): T {
  return walk(value, 0, true) as T;
}

export function redactSecrets(value: unknown): unknown {
  try {
    return walk(value, 0);
  } catch {
    // Fail closed: a value this walk could not finish must never be logged as-is.
    // Callers cast the result to a record or array, so only a string input keeps
    // the bare placeholder; anything else keeps a container shape.
    if (typeof value === "string") return PLACEHOLDER("redaction-error");
    return { error: PLACEHOLDER("redaction-error") };
  }
}
