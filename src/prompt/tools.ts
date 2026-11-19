import { createHash } from "node:crypto";

/** Serializable wire definition of one tool: no `execute` or other runtime fields. */
export interface ToolWireDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolGeneration {
  /** sha256 hex of the canonical serialization of `tools` and `capabilityChoices`. */
  id: string;
  /** Tools sorted by name, with every object key sorted recursively. */
  tools: ToolWireDef[];
  capabilityChoices: Record<string, unknown>;
}

/**
 * Builds the canonical tool list for one prefix generation. Pure: the input is
 * not mutated, and equal tool sets (in any order, with any schema key order)
 * give equal output and an equal id. A changed name, description, schema or
 * capability choice changes the id.
 */
export function buildToolGeneration(
  tools: readonly ToolWireDef[],
  capabilityChoices: Record<string, unknown> = {},
): ToolGeneration {
  if (!isPlainObject(capabilityChoices)) throw new Error("Capability choices must be a plain object");
  const seen = new Set<string>();
  for (const tool of tools) {
    if (typeof tool.name !== "string" || typeof tool.description !== "string") {
      throw new Error("Tool name and description must be strings");
    }
    if (!isPlainObject(tool.parameters)) throw new Error(`Tool ${tool.name} parameters must be a plain object`);
    if (seen.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    seen.add(tool.name);
  }

  const canonicalTools = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: canonicalize(tool.parameters) as Record<string, unknown>,
    }))
    .sort((a, b) => compareCodeUnits(a.name, b.name));
  const canonicalChoices = canonicalize(capabilityChoices) as Record<string, unknown>;

  const id = createHash("sha256")
    .update(JSON.stringify({ tools: canonicalTools, capabilityChoices: canonicalChoices }))
    .digest("hex");
  return { id, tools: canonicalTools, capabilityChoices: canonicalChoices };
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep copy with object keys sorted; arrays keep their order. Rejects values
 * that are not JSON data, including objects such as Date, Map and class
 * instances that would otherwise serialize to something lossy.
 */
function canonicalize(value: unknown, ancestors: object[] = []): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Tool definitions must not contain non-finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new Error(`Tool definitions must be JSON data, found ${typeof value}`);
  }
  if (ancestors.includes(value)) throw new Error("Tool definitions must not contain cycles");
  const next = [...ancestors, value];
  if (Array.isArray(value)) return value.map((item) => canonicalize(item === undefined ? null : item, next));
  if (!isPlainObject(value)) throw new Error("Tool definitions must be JSON data, found a non-plain object");
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    const item = value[key];
    if (item === undefined) continue;
    // defineProperty, not assignment: an own "__proto__" key from a parsed schema
    // must stay a data key instead of invoking the prototype setter.
    Object.defineProperty(out, key, {
      value: canonicalize(item, next),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
