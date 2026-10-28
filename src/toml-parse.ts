import * as toml from "toml";

/**
 * Shared TOML parsing for config, project detection and write validation.
 *
 * toml 5 differs from toml 3 in two ways that matter here:
 * - integers beyond Number.MAX_SAFE_INTEGER throw unless the `bigint` option is set,
 *   where toml 3 returned a rounded number. One large number must not make a whole
 *   config or manifest unparseable, so we retry with `bigint` and convert back.
 * - tables are null-prototype objects (no toString/hasOwnProperty). Callers expect
 *   ordinary objects, so the result is copied into plain objects.
 *
 * A `__proto__` key is dropped while copying: assigning it on an ordinary object
 * would change that object's prototype (a hostile project-local config could use it
 * to alter the merged configuration).
 */
export function parseToml(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = toml.parse(text);
  } catch (error) {
    if (!isLosslessIntegerError(error)) throw error;
    parsed = toml.parse(text, { bigint: true });
  }
  return toPlain(parsed) as Record<string, unknown>;
}

function isLosslessIntegerError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("cannot be represented losslessly");
}

function toPlain(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(toPlain);
  if (value instanceof Date) return value;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "__proto__") continue;
      out[key] = toPlain(item);
    }
    return out;
  }
  return value;
}
