/**
 * Deterministic secret redaction for tool results and logged tool-call args (#579).
 */

import { redactUrlsInText } from "./url-query.js";

const MAX_DEPTH = 8;
/** Upper bound on the text the depth-limit fallback will scan in one go. */
const MAX_SERIALIZED_CHARS = 262_144;
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

/**
 * Fail closed at the depth limit in non-strict mode: serialize the subtree once
 * and redact the resulting text, so nothing below the limit survives verbatim.
 * Serialization is itself a place to fail (cycles, BigInt, throwing getters), so
 * every branch that cannot produce redacted text of bounded size yields a
 * placeholder instead. Nothing below the limit is walked again, which keeps the
 * cost of a pathological subtree bounded by one `JSON.stringify`.
 */
function redactAtDepthLimit(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  // Primitives (and functions, which non-strict mode never walks at any depth)
  // cannot be traversed further below the limit.
  if (value === null || typeof value !== "object") return value;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return PLACEHOLDER("depth-limit");
  }
  if (typeof serialized !== "string" || serialized.length > MAX_SERIALIZED_CHARS) {
    return PLACEHOLDER("depth-limit");
  }
  return redactString(serialized);
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
    return PLACEHOLDER("redaction-error");
  }
}
