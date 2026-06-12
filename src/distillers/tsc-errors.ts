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
    const groups = new Map<string, { code: string; message: string; locations: string[] }>();
    const genericErrors: string[] = [];

    for (const line of lines) {
      const match = line.match(ERROR_LINE);
      if (match) {
        const [, file, lineNo, , code, message] = match;
        const key = `${code}:${message.trim()}`;
        const existing = groups.get(key);
        if (existing) {
          existing.locations.push(`${file}:${lineNo}`);
        } else {
          groups.set(key, {
            code,
            message: message.trim(),
            locations: [`${file}:${lineNo}`],
          });
        }
        continue;
      }
      if (/^error\b/i.test(line.trim()) && line.length < 300) {
        genericErrors.push(line.trim());
      }
    }

    if (groups.size === 0 && genericErrors.length === 0) {
      return lines.slice(0, intensity === "full" ? 20 : 40).join("\n");
    }

    const maxGroups = intensity === "full" ? 25 : 50;
    const maxLocationsPerGroup = intensity === "full" ? 20 : 50;
    const rendered: string[] = [];
    for (const group of groups.values()) {
      const shownLocations = group.locations.slice(0, maxLocationsPerGroup);
      const omitted = group.locations.length - shownLocations.length;
      rendered.push(
        `${group.code} ${group.message}`,
        `  ${group.locations.length} location(s): ${shownLocations.join(", ")}${
          omitted > 0 ? `, ... ${omitted} more` : ""
        }`,
      );
      if (rendered.length / 2 >= maxGroups) break;
    }

    const totalLocations =
      [...groups.values()].reduce((sum, group) => sum + group.locations.length, 0) +
      genericErrors.length;
    const header =
      groups.size > 0
        ? `${groups.size} unique build error(s), ${totalLocations} location(s)`
        : `${genericErrors.length} build error(s)`;
    return [header, ...rendered, ...genericErrors].join("\n");
  }
}
