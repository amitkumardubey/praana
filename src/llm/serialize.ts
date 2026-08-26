// ============================================================
// PRAANA — Deterministic Tool Result Serializer
// ============================================================

/** Maximum character length for serialized tool outputs (~16,000 tokens). */
export const MAX_TOOL_RESULT_CHARS = 64_000;

/**
 * Safely serialize any tool execution result into a canonical string.
 *
 * Handles strings, primitives, objects, circular structures, Errors,
 * and caps maximum output length to protect the context window.
 */
export function serializeToolResult(result: unknown, isError?: boolean): string {
  if (result === undefined || result === null) {
    return isError ? "Error: Execution failed with no output" : "Success (no output)";
  }

  if (typeof result === "string") {
    return truncateResult(result);
  }

  if (result instanceof Error) {
    const text = result.stack || `${result.name}: ${result.message}`;
    return truncateResult(text);
  }

  if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
    return String(result);
  }

  try {
    const seen = new WeakSet();
    const json = JSON.stringify(
      result,
      (_key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value)) {
            return "[Circular]";
          }
          seen.add(value);
        }
        if (typeof value === "bigint") {
          return value.toString();
        }
        return value;
      },
      2,
    );
    return truncateResult(json);
  } catch (err) {
    return `[Unserializable Result: ${String(err)}]`;
  }
}

function truncateResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) {
    return text;
  }
  const keep = text.slice(0, MAX_TOOL_RESULT_CHARS);
  const truncatedChars = text.length - MAX_TOOL_RESULT_CHARS;
  return `${keep}\n\n<!-- [truncated ${truncatedChars} chars to preserve token budget] -->`;
}
