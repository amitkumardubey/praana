import type { ContentType } from "./types.js";

/**
 * Unicode ranges for common scripts.
 * Returns the fraction of a token each character represents.
 * CJK characters are typically 1-2 tokens each (~1.5 chars/token = ~0.67 tokens/char).
 * Emoji are ~1 token each (~1 char/token = 1 token/char).
 * Latin characters average ~4 chars/token (= 0.25 tokens/char).
 */
function charTokenFraction(codePoint: number): number {
  // Emoji: 0x1F000-0x1FFFF (supplementary symbols, emoticons, etc.)
  // ~1 token per emoji
  if (codePoint >= 0x1f000 && codePoint <= 0x1ffff) return 1;
  // CJK Unified Ideographs (common Chinese/Japanese/Korean characters)
  // ~1.5 chars/token = ~0.67 tokens/char
  if (codePoint >= 0x4e00 && codePoint <= 0x9fff) return 0.667;
  // CJK Extension A (rare Chinese characters)
  if (codePoint >= 0x3400 && codePoint <= 0x4dbf) return 0.667;
  // CJK Compatibility Ideographs
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 0.667;
  // Hangul Syllables (Korean)
  if (codePoint >= 0xac00 && codePoint <= 0xd7af) return 0.667;
  // Hiragana and Katakana (Japanese)
  if (codePoint >= 0x3040 && codePoint <= 0x309f) return 0.667; // Hiragana
  if (codePoint >= 0x30a0 && codePoint <= 0x30ff) return 0.667; // Katakana
  // Default: Latin and other scripts
  // ~4 chars/token = 0.25 tokens/char
  return 0.25;
}

/**
 * Rough token estimate with CJK/emoji awareness.
 * Uses weighted character counting: Latin ~0.25 tokens/char, CJK ~0.67, emoji ~1.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    // Handle surrogate pairs (emoji and other supplementary plane chars)
    const code = char.codePointAt(0)!;
    tokens += charTokenFraction(code);
  }
  return Math.ceil(tokens);
}

/** Generic head/tail summary for Phase 1 (specialized distillers land in Phase 2). */
export function summarizeGeneric(rawText: string, contentType: ContentType): string {
  if (contentType === "error") {
    return rawText;
  }

  const lines = rawText.split("\n");
  if (lines.length <= 8 && rawText.length <= 600) {
    return rawText;
  }

  const headChars = 400;
  const tailChars = 400;
  if (rawText.length <= headChars + tailChars + 40) {
    return rawText;
  }

  const head = rawText.slice(0, headChars).trimEnd();
  const tail = rawText.slice(-tailChars).trimStart();
  const omitted = rawText.length - head.length - tail.length;
  return `${head}\n… [${omitted.toLocaleString()} chars omitted] …\n${tail}`;
}

export function buildArtifactCard(
  artifactId: string,
  sourceTool: string,
  command: string | undefined,
  rawTokens: number,
  summary: string,
): string {
  const label = command ? `${sourceTool}: ${command}` : sourceTool;
  const lines = [
    `[artifact: ${artifactId} | ${label} | ${rawTokens.toLocaleString()} tokens raw]`,
    summary,
    `Retrieve: retrieve_artifact("${artifactId}")`,
  ];
  return lines.join("\n");
}
