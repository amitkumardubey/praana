export type SynchronizedOutput = "auto" | "always" | "never";

/** Parse PRAANA_TUI_SYNC_OUTPUT, defaulting to OpenTUI's auto mode. */
export function parseSynchronizedOutput(value: string | undefined): SynchronizedOutput {
  const v = value?.toLowerCase();
  if (v === "always") return "always";
  if (v === "never") return "never";
  return "auto";
}
