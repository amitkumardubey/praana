/**
 * Single rule for "this tool result is an error".
 *
 * A result object with `ok === false` is an error, with one exception: a
 * `run_tests` result where the tests ran and reported failures (no `error`
 * field). That is a normal outcome the model should read, not a tool failure.
 * A `run_tests` result with an `error` (spawn failure, sandbox block, invalid
 * arguments) is still an error.
 */
export function toolResultIsError(toolName: string, result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const r = result as { ok?: unknown; error?: unknown };
  if (r.ok !== false) return false;
  if (toolName === "run_tests" && r.error === undefined) return false;
  return true;
}
