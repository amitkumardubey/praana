import {
  isDiffContent,
  isTestOutputContent,
  isBuildOutputContent,
  isCodeContent,
  hasTestMarkers,
} from "../domain/coding-domain.js";
import type { ContentType } from "./types.js";

/** Fast regex-based content-type classification (<1ms). */
export function classifyContentType(text: string): ContentType {
  const trimmed = text.trim();
  if (!trimmed) return "other";

  if (isDiffContent(trimmed)) return "diff";
  if (isTestOutputContent(trimmed)) return "test_output";
  if (isBuildOutputContent(trimmed)) return "build_output";

  if (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    looksLikeJson(trimmed)
  ) {
    return "json";
  }

  // Error classification: only when the content is primarily an error,
  // not a larger output that happens to contain the word "Error".
  // Test output and build output are already caught above.
  if (
    trimmed.length < 500 &&
    /\b(Error|error|EXCEPTION)\b/.test(trimmed) &&
    !hasTestMarkers(trimmed)
  ) {
    return "error";
  }

  if (isCodeContent(trimmed)) return "code";

  const lines = trimmed.split("\n");
  if (lines.length > 20 && hasRepetitiveLines(lines)) {
    return "log";
  }

  if (/\n\n/.test(trimmed) && /[a-z]{4,}/i.test(trimmed)) {
    return "prose";
  }

  return "other";
}

function looksLikeJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function hasRepetitiveLines(lines: string[]): boolean {
  const counts = new Map<string, number>();
  for (const line of lines.slice(0, 100)) {
    const key = line.trim().slice(0, 80);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if ((counts.get(key) ?? 0) >= 3) return true;
  }
  return false;
}
