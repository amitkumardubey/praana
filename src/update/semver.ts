/** Compare dotted release versions, ignoring a leading `v` and any prerelease suffix. */

export function parseReleaseTuple(version: string): [number, number, number] | null {
  const trimmed = version.trim();
  if (!trimmed) return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(trimmed);
  if (!match) return null;
  return [
    Number.parseInt(match[1]!, 10),
    Number.parseInt(match[2]!, 10),
    Number.parseInt(match[3]!, 10),
  ];
}

function cmpTuple(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

/** True when `latest` is a strictly greater major.minor.patch than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const latestTuple = parseReleaseTuple(latest);
  const currentTuple = parseReleaseTuple(current);
  if (!latestTuple || !currentTuple) return false;
  return cmpTuple(latestTuple, currentTuple) > 0;
}

export function normalizeVersionLabel(version: string): string {
  const trimmed = version.trim();
  if (!trimmed) return "v0.0.0";
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}
