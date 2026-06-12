import type { Distiller, DistillerIntensity } from "../context-engine/distiller.js";
import type { ContentType } from "../context-engine/types.js";

export class SearchDistiller implements Distiller {
  readonly name = "rg-search";
  readonly contentTypes: ContentType[] = ["search_results"];
  readonly mode = "sync" as const;

  distill(input: string, intensity: DistillerIntensity): string {
    const lines = input.split("\n").filter((l) => l.trim().length > 0);
    const limit = intensity === "full" ? 15 : 30;
    const seen = new Set<string>();
    const kept: string[] = [];

    for (const line of lines) {
      const normalized = line.replace(/\s+/g, " ").trim();
      const key = normalized.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(line);
      if (kept.length >= limit) break;
    }

    if (kept.length === 0) return input.slice(0, 800);
    const omitted = Math.max(0, lines.length - kept.length);
    const header =
      omitted > 0
        ? `Search results: showing ${kept.length} of ${lines.length} lines`
        : `Search results: ${kept.length} lines`;
    return [header, ...kept].join("\n");
  }
}
