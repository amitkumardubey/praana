/** Best-effort terminal width for layout (TUI). */
export function getTerminalWidth(): number {
  const cols = process.stdout.columns ?? process.stderr.columns ?? 80;
  return Math.max(40, Math.min(cols, 200));
}
