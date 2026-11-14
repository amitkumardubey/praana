/**
 * Restricted ingestion of `config_overrides` from `settings.json`.
 *
 * This table is a stopgap for the v1 approved config keys and is replaced by
 * a typed settings registry. Nothing in this module merges overrides into the
 * active config.
 */

export type OverrideSpec =
  | { kind: "boolean" }
  | { kind: "int"; min: number; max: number }
  | { kind: "enum"; options: readonly string[] }
  | { kind: "string"; maxLength?: number }
  | { kind: "stringList"; maxItems: number; maxItemLength: number };

export type OverrideValue = boolean | number | string | string[];

export const APPROVED_CONFIG_OVERRIDES: Readonly<Record<string, OverrideSpec>> = Object.freeze({
  "edit.confirm": { kind: "boolean" },
  "tools.block_repeat_reads": { kind: "boolean" },
  "lsp.enabled": { kind: "boolean" },
  "lsp.diagnostics": { kind: "boolean" },
  "lsp.format_on_edit": { kind: "boolean" },
  "verify.enabled": { kind: "boolean" },
  "verify.syntax": { kind: "boolean" },
  "verify.typecheck": { kind: "boolean" },
  "verify.tests": { kind: "boolean" },
  // Positive integer bounded at 1..1000 for v1 settings overrides.
  "turn.pause_after_steps": { kind: "int", min: 1, max: 1000 },
  "ui.ambient": { kind: "enum", options: ["inline", "quiet"] },
  "ui.tool_icons": { kind: "enum", options: ["unicode", "ascii"] },
  "ui.syntax_theme": { kind: "string", maxLength: 64 },
  "ui.show_cost": { kind: "boolean" },
  "ui.markdown_rendering": { kind: "boolean" },
  "ui.syntax_highlighting": { kind: "boolean" },
});

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** Plain JSON object: not null, not an array, prototype Object.prototype or null. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validatePathSegments(path: string): { ok: true; segments: string[] } | { ok: false; reason: string } {
  if (path.length === 0) return { ok: false, reason: "Override path cannot be empty" };
  const segments = path.split(".");
  for (const segment of segments) {
    if (segment.length === 0) return { ok: false, reason: "Override path contains an empty segment" };
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      return { ok: false, reason: `Forbidden prototype segment "${segment}" in override path` };
    }
  }
  return { ok: true, segments };
}

function validateOverrideValue(
  spec: OverrideSpec,
  value: unknown,
): { ok: true; value: OverrideValue } | { ok: false; reason: string } {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return { ok: false, reason: "Expected a leaf value, not a nested object" };
  }
  switch (spec.kind) {
    case "boolean": {
      if (typeof value !== "boolean") return { ok: false, reason: "Expected a boolean" };
      return { ok: true, value };
    }
    case "int": {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < spec.min || value > spec.max) {
        return { ok: false, reason: `Expected an integer between ${spec.min} and ${spec.max}` };
      }
      return { ok: true, value };
    }
    case "enum": {
      if (typeof value !== "string" || !spec.options.includes(value)) {
        return { ok: false, reason: `Expected one of: ${spec.options.join(", ")}` };
      }
      return { ok: true, value };
    }
    case "string": {
      if (typeof value !== "string") {
        return { ok: false, reason: "Expected a non-empty string" };
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return { ok: false, reason: "Expected a non-empty string" };
      }
      if (spec.maxLength !== undefined && trimmed.length > spec.maxLength) {
        return { ok: false, reason: `Expected a string of at most ${spec.maxLength} characters` };
      }
      return { ok: true, value: trimmed };
    }
    case "stringList": {
      if (!Array.isArray(value)) {
        return { ok: false, reason: "Expected an array of strings" };
      }
      if (value.length > spec.maxItems) {
        return { ok: false, reason: `Expected at most ${spec.maxItems} entries` };
      }
      const list: string[] = [];
      for (const item of value) {
        if (typeof item !== "string" || item.length === 0 || item.length > spec.maxItemLength || /\s/.test(item)) {
          return {
            ok: false,
            reason: `Each entry must be a non-empty string of at most ${spec.maxItemLength} characters with no whitespace`,
          };
        }
        list.push(item);
      }
      return { ok: true, value: list };
    }
    default: {
      const exhaustive: never = spec;
      throw new Error(`Unhandled override spec: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export type AcceptedOverrides = Record<string, OverrideValue>;

export interface RejectedOverride {
  path: string;
  reason: string;
}

export interface ParseConfigOverridesResult {
  accepted: AcceptedOverrides;
  rejected: RejectedOverride[];
}

export function parseConfigOverrides(raw: unknown): ParseConfigOverridesResult {
  if (raw === undefined) return { accepted: {}, rejected: [] };
  if (!isPlainObject(raw)) {
    return {
      accepted: {},
      rejected: [{ path: "config_overrides", reason: "config_overrides must be a plain object" }],
    };
  }

  const accepted: AcceptedOverrides = {};
  const rejected: RejectedOverride[] = [];

  for (const key of Object.keys(raw)) {
    const pathCheck = validatePathSegments(key);
    if (!pathCheck.ok) {
      rejected.push({ path: key, reason: pathCheck.reason });
      continue;
    }
    const spec = Object.prototype.hasOwnProperty.call(APPROVED_CONFIG_OVERRIDES, key)
      ? APPROVED_CONFIG_OVERRIDES[key]
      : undefined;
    if (!spec) {
      rejected.push({ path: key, reason: "Unapproved config override path" });
      continue;
    }
    const valueCheck = validateOverrideValue(spec, raw[key]);
    if (!valueCheck.ok) {
      rejected.push({ path: key, reason: valueCheck.reason });
      continue;
    }
    Object.defineProperty(accepted, key, {
      value: valueCheck.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  for (const sym of Object.getOwnPropertySymbols(raw)) {
    rejected.push({ path: String(sym), reason: "Symbol keys are not allowed in config_overrides" });
  }

  return { accepted, rejected };
}

function toPlainTree(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_SEGMENTS.has(key)) continue;
    const val = node[key];
    let converted: unknown = val;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      converted = toPlainTree(val as Record<string, unknown>);
    } else if (Array.isArray(val)) {
      converted = [...val];
    }
    Object.defineProperty(out, key, {
      value: converted,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

export type ExpandOverridesResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

function findPrefixConflict(
  parsedKeys: Array<{ key: string; segments: string[] }>,
  keySet: Set<string>,
): { prefix: string; key: string } | undefined {
  for (const { key, segments } of parsedKeys) {
    for (let i = 1; i < segments.length; i++) {
      const prefix = segments.slice(0, i).join(".");
      if (keySet.has(prefix)) {
        return { prefix, key };
      }
    }
  }
  return undefined;
}

/**
 * Expand a map of dotted override paths into a nested plain object using
 * `Object.create(null)` intermediate nodes so prototype pollution is impossible.
 * Order-independent: rejects dotted prefix conflicts and any unapproved path.
 */
export function expandOverrides(accepted: Record<string, unknown>): ExpandOverridesResult {
  if (!isPlainObject(accepted)) {
    return { ok: false, error: "Overrides must be a plain object" };
  }
  if (Object.getOwnPropertySymbols(accepted).length > 0) {
    return { ok: false, error: "Symbol keys are not allowed in config_overrides" };
  }

  const keys = Object.keys(accepted).sort((a, b) => {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
  const keySet = new Set(keys);
  const parsedKeys: Array<{ key: string; segments: string[] }> = [];

  for (const key of keys) {
    const pathCheck = validatePathSegments(key);
    if (!pathCheck.ok) {
      return { ok: false, error: `Invalid config override path "${key}": ${pathCheck.reason}` };
    }
    parsedKeys.push({ key, segments: pathCheck.segments });
  }

  const conflict = findPrefixConflict(parsedKeys, keySet);
  if (conflict) {
    return {
      ok: false,
      error: `Conflicting config override keys "${conflict.prefix}" and "${conflict.key}": "${conflict.prefix}" is a dotted prefix of "${conflict.key}"`,
    };
  }

  const root: Record<string, unknown> = Object.create(null);
  for (const { key, segments } of parsedKeys) {
    if (!Object.prototype.hasOwnProperty.call(APPROVED_CONFIG_OVERRIDES, key)) {
      return { ok: false, error: `Unapproved config override path "${key}"` };
    }
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (seg === undefined) continue;
      const existing = cursor[seg];
      if (existing === undefined) {
        const next: Record<string, unknown> = Object.create(null);
        cursor[seg] = next;
        cursor = next;
      } else {
        cursor = existing as Record<string, unknown>;
      }
    }
    const leaf = segments.at(-1);
    if (leaf === undefined) continue;
    const rawVal = accepted[key];
    cursor[leaf] = Array.isArray(rawVal) ? [...rawVal] : rawVal;
  }

  return { ok: true, value: toPlainTree(root) };
}
