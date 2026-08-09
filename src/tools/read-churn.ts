export const CHURN_PATH_THRESHOLD = 3;
export const ARTIFACT_RETRIEVE_RETRY_THRESHOLD = 2;

export type FileAccessChannel = "read_file" | "shell" | "retrieve";

export interface ArtifactRetrieveParams {
  grep?: string;
  lineStart?: number;
  lineEnd?: number;
  jsonPath?: string;
}

/** Stable key for identical-retrieve detection. Field order is normalized. */
export function buildArtifactRetrievalKey(
  id: string,
  params: ArtifactRetrieveParams = {},
): string {
  return [
    id,
    params.grep ?? "",
    params.lineStart ?? "",
    params.lineEnd ?? "",
    params.jsonPath ?? "",
  ].join("\0");
}

export function buildPathChurnHint(
  displayPath: string,
  count: number,
  channels: Iterable<string>,
): string {
  const ch = [...channels].sort().join(", ");
  return (
    `Churn: ${displayPath} accessed ${count}× this session (${ch}). `
    + "Prefer one narrow retrieve_artifact(id, lineStart, lineEnd) or state a preliminary conclusion."
  );
}

export function buildRetrieveChurnHint(id: string, count: number): string {
  return (
    `Already retrieved ${id} with these filters (${count}×) — returning artifact card. `
    + "Prefer a narrower line range or conclude from prior content."
  );
}
