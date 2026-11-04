export type SynchronizedOutput = "auto" | "always" | "never";

/** Parse PRAANA_TUI_SYNC_OUTPUT, defaulting to OpenTUI's auto mode. */
export function parseSynchronizedOutput(value: string | undefined): SynchronizedOutput {
  const v = value?.toLowerCase();
  if (v === "always") return "always";
  if (v === "never") return "never";
  return "auto";
}

/**
 * Parse PRAANA_TUI_STREAM_BATCH_MS — integer milliseconds for TUI stream-delta
 * batching. `0` (the default) disables batching entirely (exact current
 * behavior). Invalid, negative or non-integer values fall back to `0`; values
 * above 250 are capped at 250. Experimental, default off.
 */
export function parseStreamBatchMs(value: string | undefined): number {
  if (value === undefined) return 0;
  const trimmed = value.trim();
  if (!/^-?\d+$/.test(trimmed)) return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 250);
}
