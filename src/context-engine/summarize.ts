import type { ContentType } from "./types.js";
export { estimateTokens } from "../token-estimate.js";

export interface ArtifactCardRange {
  sourceLineStart?: number;
  sourceLineEnd?: number;
  sourceTotalLines?: number;
  sourceCapped?: boolean;
  sourceLongLinesCut?: number;
}

const MAX_READ_LINE_CHARS = 2000;

export function formatLongLinesCutWarning(longLinesCut: number): string {
  return (
    `${longLinesCut} line${longLinesCut === 1 ? "" : "s"} cut at ${MAX_READ_LINE_CHARS} characters; ` +
    "the rest of a cut line is not available through read_file, use the shell to read the rest of a cut line, " +
    "and a cut line cannot be targeted by edit_file, so never copy cut text into oldText"
  );
}

/**
 * Format the line range and continuation hint for a `read_file` artifact (#811).
 *
 * Returns `undefined` when `sourceTotalLines` is unknown so legacy rows and
 * direct 4-argument `buildArtifactCard` callers keep their exact wording.
 */
export function formatReadFileRangeSummary(
  range?: ArtifactCardRange,
): string | undefined {
  if (!range || range.sourceTotalLines === undefined) return undefined;
  const total = range.sourceTotalLines;
  if (total === 0) {
    return "0 of 0 lines (total_lines 0)";
  }
  const start = range.sourceLineStart ?? 1;
  if (start > total) {
    return `offset ${start} is past the end of the file (total_lines ${total})`;
  }
  const end = range.sourceLineEnd ?? start;
  const capped = Boolean(range.sourceCapped) && end < total;
  const longLinesCut = range.sourceLongLinesCut ?? 0;
  const parts = [`lines ${start}-${end} of ${total}`];
  if (capped || longLinesCut > 0) parts.push("truncated");
  if (longLinesCut > 0) parts.push(formatLongLinesCutWarning(longLinesCut));
  if (capped) parts.push(`call read_file with offset=${end + 1} for the next part`);
  return parts.join("; ");
}

/**
 * Build a compact artifact card for the LLM prompt.
 * Default is a tiny stub — full bytes are retrievable on demand via
 * retrieve_artifact. No distillation summary is embedded in the card.
 */
export function buildArtifactCard(
  artifactId: string,
  sourceTool: string,
  command: string | undefined,
  rawTokens: number,
  range?: ArtifactCardRange,
): string {
  const label = command ? `${sourceTool}: ${command}` : sourceTool;
  const rangeSummary = sourceTool === "read_file" ? formatReadFileRangeSummary(range) : undefined;
  const middle = rangeSummary ? `${label} | ${rangeSummary}` : label;
  return `[artifact: ${artifactId} | ${middle} | ${rawTokens.toLocaleString()} tokens raw]\nRetrieve: retrieve_artifact("${artifactId}")`;
}

/**
 * Generic head/tail summarizer (legacy). Kept for reference; no longer
 * used as the default card body. Specialist distillers (npm-test, git-diff)
 * may still produce summaries when they are the matched distiller.
 */
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
