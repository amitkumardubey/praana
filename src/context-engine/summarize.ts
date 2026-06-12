import type { ContentType } from "./types.js";

/** Rough token estimate: 1 token ≈ 4 chars. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
