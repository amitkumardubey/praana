import type { ContentType } from "./types.js";

export type DistillerIntensity = "lite" | "full";
export type DistillerMode = "sync" | "deferred";

export interface Distiller {
  readonly name: string;
  readonly contentTypes: ContentType[];
  readonly mode: DistillerMode;
  distill(input: string, intensity: DistillerIntensity, contentType?: ContentType): string;
}

export interface DistillResult {
  summary: string;
  distillerName: string;
  execTimeMs: number;
  deferred: boolean;
}

export interface DistillDeferredResult {
  pendingSummary: string;
  distillerName: string;
  backfill: () => Promise<DistillResult>;
}

const PENDING_MARKER = "[compression pending — full content available via retrieve_artifact]";

/**
 * Output ≤ input invariant: no distiller may produce a summary larger than
 * the raw text. If compression would bloat, return the raw text unchanged.
 * Applied to both the sync and deferred-backfill paths.
 */
function clampToInput(summary: string, input: string): string {
  return summary.length > input.length ? input : summary;
}

export function buildPendingSummary(): string {
  return PENDING_MARKER;
}

export function isPendingSummary(summary: string): boolean {
  return summary.includes(PENDING_MARKER);
}

export class DistillerRegistry {
  private readonly distillers: Distiller[] = [];

  register(distiller: Distiller): void {
    this.distillers.push(distiller);
  }

  find(contentType: ContentType): Distiller | null {
    return this.distillers.find((d) => d.contentTypes.includes(contentType)) ?? null;
  }

  selectIntensity(
    rawTokens: number,
    defaultIntensity: DistillerIntensity,
  ): DistillerIntensity {
    if (rawTokens > 2000) return "full";
    if (rawTokens > 400) return "lite";
    return defaultIntensity;
  }

  distillSync(
    input: string,
    contentType: ContentType,
    intensity: DistillerIntensity,
  ): DistillResult {
    const distiller = this.find(contentType);
    const start = performance.now();
    if (!distiller || distiller.mode === "deferred") {
      return {
        summary: "",
        distillerName: distiller?.name ?? "none",
        execTimeMs: performance.now() - start,
        deferred: false,
      };
    }
    const summary = distiller.distill(input, intensity, contentType);
    return {
      summary: clampToInput(summary, input),
      distillerName: distiller.name,
      execTimeMs: performance.now() - start,
      deferred: false,
    };
  }

  distillForIngestion(
    input: string,
    contentType: ContentType,
    intensity: DistillerIntensity,
  ): DistillResult | DistillDeferredResult {
    const distiller = this.find(contentType);
    if (!distiller) {
      return this.distillSync(input, contentType, intensity);
    }

    if (distiller.mode === "deferred") {
      return {
        pendingSummary: buildPendingSummary(),
        distillerName: distiller.name,
        backfill: async () => {
          const start = performance.now();
          const summary = distiller.distill(input, intensity, contentType);
          return {
            summary: clampToInput(summary, input),
            distillerName: distiller.name,
            execTimeMs: performance.now() - start,
            deferred: true,
          };
        },
      };
    }

    return this.distillSync(input, contentType, intensity);
  }
}
