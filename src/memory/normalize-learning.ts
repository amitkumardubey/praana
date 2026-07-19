// ============================================================
// PRAANA Memory — Learning content normalization
//
// Deterministic post-processing so summarizer output stays
// scannable key points (issue #196).
// ============================================================

/** Hard cap aligned with the summarizer system prompt. */
export const MAX_LEARNING_CONTENT_CHARS = 120;

/**
 * Normalize raw LLM learning content into a concise key point.
 * Returns null when nothing useful remains after cleanup.
 */
export function normalizeLearningContent(content: string): string | null {
  if (typeof content !== "string") return null;

  let text = content.trim().replace(/\s+/g, " ");
  if (!text) return null;

  // Strip leading bullet / markdown list noise
  text = text.replace(/^([-*•]|\d+[.)])\s*/, "").trim();
  if (!text) return null;

  // Keep the first sentence only when the model returns a paragraph
  const sentenceEnd = text.search(/[.?!]\s+\S/);
  if (sentenceEnd !== -1) {
    text = text.slice(0, sentenceEnd + 1).trim();
  }

  if (!text) return null;

  if (text.length <= MAX_LEARNING_CONTENT_CHARS) return text;

  const truncated = text.slice(0, MAX_LEARNING_CONTENT_CHARS);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > MAX_LEARNING_CONTENT_CHARS * 0.5) {
    return truncated.slice(0, lastSpace).trimEnd();
  }
  return truncated.trimEnd();
}
