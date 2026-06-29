/** Best-effort terminal row count for layout (TUI). */
export function getTerminalRows(): number {
  const rows = process.stdout.rows ?? process.stderr.rows ?? 24;
  return Math.max(12, Math.min(rows, 200));
}

export interface TranscriptBudgetOptions {
  showLogo?: boolean;
  showToast?: boolean;
  showScrollHint?: boolean;
}

/**
 * Lines available for transcript content after reserving chrome
 * (prompt, status bar, padding, optional logo/toast).
 */
export function getTranscriptLineBudget(options: TranscriptBudgetOptions = {}): number {
  const rows = getTerminalRows();
  let overhead = 7; // outer padding, prompt row, status bar, gaps
  if (options.showLogo) overhead += 10;
  if (options.showToast) overhead += 1;
  if (options.showScrollHint) overhead += 2;
  return Math.max(6, rows - overhead);
}
