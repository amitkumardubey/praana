import type { Distiller, DistillerIntensity } from "../context-engine/distiller.js";
import type { ContentType } from "../context-engine/types.js";

const CONTEXT_LINES = 2;

export class DiffDistiller implements Distiller {
  readonly name = "git-diff";
  readonly contentTypes: ContentType[] = ["diff"];
  readonly mode = "sync" as const;

  distill(input: string, intensity: DistillerIntensity): string {
    const context = intensity === "full" ? 1 : CONTEXT_LINES;
    const lines = input.split("\n");
    const out: string[] = [];
    let inHunk = false;
    let hunkBuffer: string[] = [];
    let hunkHasChange = false;

    const flushHunk = () => {
      if (!hunkHasChange) {
        inHunk = false;
        hunkBuffer = [];
        return;
      }
      const compact = compactHunk(hunkBuffer, context);
      if (compact.length > 0) out.push(...compact);
      inHunk = false;
      hunkBuffer = [];
      hunkHasChange = false;
    };

    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        flushHunk();
        out.push(line);
        continue;
      }
      if (line.startsWith("@@")) {
        flushHunk();
        inHunk = true;
        hunkBuffer = [line];
        hunkHasChange = false;
        continue;
      }
      if (inHunk) {
        if (line.startsWith("+") && !line.startsWith("+++")) hunkHasChange = true;
        if (line.startsWith("-") && !line.startsWith("---")) hunkHasChange = true;
        hunkBuffer.push(line);
        continue;
      }
      if (intensity !== "full") {
        out.push(line);
      }
    }
    flushHunk();

    if (out.length === 0) return input.slice(0, 1200);
    return out.join("\n");
  }
}

function compactHunk(lines: string[], context: number): string[] {
  const changeIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("+") || line.startsWith("-")) {
      if (!line.startsWith("+++") && !line.startsWith("---")) {
        changeIndexes.push(i);
      }
    }
  }
  if (changeIndexes.length === 0) return [];

  const keep = new Set<number>();
  keep.add(0);
  for (const idx of changeIndexes) {
    for (let d = -context; d <= context; d++) {
      const pos = idx + d;
      if (pos >= 0 && pos < lines.length) keep.add(pos);
    }
  }

  const sorted = [...keep].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -2;
  for (const idx of sorted) {
    if (idx > prev + 1) out.push("…");
    out.push(lines[idx]);
    prev = idx;
  }
  return out;
}
