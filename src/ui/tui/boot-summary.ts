/** Compact boot summary line for the TUI welcome panel. */
export function formatTuiBootSummary(input: {
  sessionId: string;
  contextTokens?: number;
  engineEnabled: boolean;
  skillCount: number;
  memoryEnabled: boolean;
  incognito: boolean;
}): string {
  const parts: string[] = [`session ${input.sessionId}`];
  if (input.contextTokens && input.contextTokens > 0) {
    parts.push(`ctx ~${input.contextTokens} tok`);
  }
  if (input.engineEnabled) parts.push("engine on");
  if (input.skillCount > 0) {
    parts.push(`${input.skillCount} skill${input.skillCount === 1 ? "" : "s"}`);
  }
  if (input.incognito) parts.push("incognito");
  else if (!input.memoryEnabled) {
    parts.push("mem off (enable memory.enabled in config)");
  }
  return parts.join(" · ");
}
