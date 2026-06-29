/** Extract a disclosure title from reasoning text (OpenAI-style **Title** blocks). */
export function reasoningSummary(text: string): { title: string | null; body: string } {
  const content = text.trim();
  const match = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/);
  if (!match) return { title: null, body: content };
  return { title: match[1]!.trim(), body: content.slice(match[0].length).trimEnd() };
}

export function formatThinkingDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export const THINKING_PREVIEW_LINES = 3;

/** Truncate thinking body for collapsed preview. */
export function truncateThinkingBody(
  body: string,
  maxLines = THINKING_PREVIEW_LINES
): { text: string; truncated: boolean } {
  const trimmed = body.trim();
  if (!trimmed) return { text: "", truncated: false };
  const lines = trimmed.split("\n");
  if (lines.length <= maxLines) return { text: trimmed, truncated: false };
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}
