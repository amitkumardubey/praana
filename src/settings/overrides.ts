/**
 * Restricted ingestion of `config_overrides` from `settings.json`.
 *
 * This table is a stopgap for the v1 approved config keys and is replaced by
 * the settings registry in a subsequent slice. String-shape checks here (for
 * example on `tools.web.allow_domains`) are not full domain/hostname
 * normalization, which remains in the config validators. Nothing in this
 * module merges overrides into the active config.
 */

export type OverrideSpec =
  | { kind: "boolean" }
  | { kind: "int"; min: number; max: number }
  | { kind: "enum"; options: readonly string[] }
  | { kind: "string" }
  | { kind: "stringList"; maxItems: number; maxItemLength: number };

export type OverrideValue = boolean | number | string | string[];

export const APPROVED_CONFIG_OVERRIDES: Readonly<Record<string, OverrideSpec>> = Object.freeze({
  "edit.confirm": { kind: "boolean" },
  "tools.block_repeat_reads": { kind: "boolean" },
  "tools.web.allow_domains": { kind: "stringList", maxItems: 100, maxItemLength: 253 },
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
  "ui.syntax_theme": { kind: "string" },
  "ui.show_cost": { kind: "boolean" },
  "ui.markdown_rendering": { kind: "boolean" },
  "ui.syntax_highlighting": { kind: "boolean" },
});

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
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
      if (typeof value !== "string" || value.trim().length === 0) {
        return { ok: false, reason: "Expected a non-empty string" };
      }
      return { ok: true, value };
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
    const converted = typeof val === "object" && val !== null && !Array.isArray(val)
      ? toPlainTree(val as Record<string, unknown>)
      : Array.isArray(val)
        ? [...val]
        : val;
    Object.defineProperty(out, key, {
      value: converted,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Expand a map of dotted override paths into a nested plain object using
 * `Object.create(null)` intermediate nodes so prototype pollution is impossible.
 */
export function expandOverrides(accepted: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainObject(accepted)) return {};
  const root: Record<string, unknown> = Object.create(null);

  for (const key of Object.keys(accepted)) {
    const pathCheck = validatePathSegments(key);
    if (!pathCheck.ok) continue;
    const { segments } = pathCheck;
    let cursor = root;
    let valid = true;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const existing = cursor[seg];
      if (existing === undefined) {
        const next: Record<string, unknown> = Object.create(null);
        cursor[seg] = next;
        cursor = next;
      } else if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
        cursor = existing as Record<string, unknown>;
      } else {
        valid = false;
        break;
      }
    }
    if (!valid) continue;
    const leaf = segments[segments.length - 1];
    const rawVal = accepted[key];
    cursor[leaf] = Array.isArray(rawVal) ? [...rawVal] : rawVal;
  }

  return toPlainTree(root);
}
