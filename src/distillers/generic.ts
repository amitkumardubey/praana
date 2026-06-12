import type { Distiller, DistillerIntensity } from "../context-engine/distiller.js";
import type { ContentType } from "../context-engine/types.js";

function headTail(input: string, headChars: number, tailChars: number): string {
  if (input.length <= headChars + tailChars + 40) return input;
  const head = input.slice(0, headChars).trimEnd();
  const tail = input.slice(-tailChars).trimStart();
  const omitted = input.length - head.length - tail.length;
  return `${head}\n… [${omitted.toLocaleString()} chars omitted] …\n${tail}`;
}

function summarizeJson(input: string, intensity: DistillerIntensity): string {
  try {
    const parsed = JSON.parse(input) as unknown;
    const budget = intensity === "full" ? 8 : 16;
    return JSON.stringify(compactJson(parsed, budget), null, 2);
  } catch {
    return headTail(
      input,
      intensity === "full" ? 250 : 400,
      intensity === "full" ? 250 : 400,
    );
  }
}

function compactJson(value: unknown, budget: number): unknown {
  if (Array.isArray(value)) {
    if (value.length <= budget) return value.map((item) => compactJson(item, budget));
    return [
      ...value.slice(0, budget).map((item) => compactJson(item, budget)),
      {
        __aria_summary: `${value.length - budget} array item(s) omitted`,
      },
    ];
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, child] of entries.slice(0, budget)) {
      out[key] = compactJson(child, budget);
    }
    if (entries.length > budget) {
      out.__aria_summary = `${entries.length - budget} object field(s) omitted`;
    }
    return out;
  }

  return value;
}

export class GenericDistiller implements Distiller {
  readonly name = "generic";
  readonly contentTypes: ContentType[] = ["other", "code", "prose", "json"];
  readonly mode = "sync" as const;

  distill(input: string, intensity: DistillerIntensity, contentType?: ContentType): string {
    if (contentType === "json") {
      return summarizeJson(input, intensity);
    }
    const head = intensity === "full" ? 250 : 400;
    const tail = intensity === "full" ? 250 : 400;
    return headTail(input, head, tail);
  }
}

export class LogDistiller implements Distiller {
  readonly name = "log";
  readonly contentTypes: ContentType[] = ["log"];
  readonly mode = "sync" as const;

  distill(input: string, intensity: DistillerIntensity): string {
    const lines = input.split("\n");
    const counts = new Map<string, number>();
    const errors: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
      if (/\b(error|exception|fatal)\b/i.test(trimmed)) {
        errors.push(trimmed);
      }
    }

    const maxUnique = intensity === "full" ? 8 : 15;
    const uniqueLines: string[] = [];
    for (const [line, count] of counts) {
      if (count === 1) uniqueLines.push(line);
      else uniqueLines.push(`${line} (×${count})`);
      if (uniqueLines.length >= maxUnique) break;
    }

    const tailErrors = errors.slice(-5);
    const parts = [
      `Log: ${lines.length} lines, ${counts.size} unique patterns`,
      ...uniqueLines,
    ];
    if (tailErrors.length > 0) {
      parts.push("Recent errors:", ...tailErrors);
    }
    return parts.join("\n");
  }
}
