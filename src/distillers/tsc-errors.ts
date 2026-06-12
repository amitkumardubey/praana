import type { Distiller, DistillerIntensity } from "../context-engine/distiller.js";
import type { ContentType } from "../context-engine/types.js";

const ERROR_LINE =
  /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

export class BuildDistiller implements Distiller {
  readonly name = "tsc-errors";
  readonly contentTypes: ContentType[] = ["build_output"];
  readonly mode = "sync" as const;

  distill(input: string, intensity: DistillerIntensity): string {
    const lines = input.split("\n");
    const seen = new Map<string, string>();
    const ordered: string[] = [];

    for (const line of lines) {
      const match = line.match(ERROR_LINE);
      if (match) {
        const [, file, lineNo, , code, message] = match;
        const key = `${code}:${message.trim()}`;
        if (!seen.has(key)) {
          seen.set(key, `${file}:${lineNo} ${code} ${message.trim()}`);
          ordered.push(seen.get(key)!);
        } else if (intensity === "lite") {
          ordered.push(`${file}:${lineNo} ${code} ${message.trim()}`);
        }
        continue;
      }
      if (/^error\b/i.test(line.trim()) && line.length < 300) {
        ordered.push(line.trim());
      }
    }

    if (ordered.length === 0) {
      return lines.slice(0, intensity === "full" ? 20 : 40).join("\n");
    }

    const limit = intensity === "full" ? 25 : 50;
    const header = `${ordered.length} build error(s)`;
    return [header, ...ordered.slice(0, limit)].join("\n");
  }
}
