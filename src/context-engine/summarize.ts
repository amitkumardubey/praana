import type { ContentType } from "./types.js";
export { estimateTokens } from "../token-estimate.js";

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
): string {
  const label = command ? `${sourceTool}: ${command}` : sourceTool;
  return `[artifact: ${artifactId} | ${label} | ${rawTokens.toLocaleString()} tokens raw]\nRetrieve: retrieve_artifact("${artifactId}")`;
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
