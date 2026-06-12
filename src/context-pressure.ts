import type { CompilerConfig } from "./types.js";

export {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  resolveContextWindowSync,
  fetchAndCacheContextWindow,
} from "./model-context.js";

export function resolveCompactionConfig(config: CompilerConfig): {
  autoCompactAt: number;
  autoCompactClearAt: number;
  compactChunkFraction: number;
  verbatimOnly: boolean;
} {
  return {
    autoCompactAt:
      config.auto_compact_at ?? config.compression_watermark ?? 0.75,
    autoCompactClearAt: config.auto_compact_clear_at ?? 0.55,
    compactChunkFraction:
      config.compact_chunk_fraction ?? config.compression_flush_fraction ?? 0.25,
    verbatimOnly: config.verbatim_only ?? false,
  };
}

/** Prompt fill ratio against usable context (window minus reserved output). */
export function computeContextPressureRatio(
  usedTokens: number,
  contextWindowTokens: number,
  reservedOutputTokens = 0,
): number {
  const usable = Math.max(1, contextWindowTokens - reservedOutputTokens);
  return usedTokens / usable;
}

/**
 * Hysteresis: arm at auto_compact_at, disarm below auto_compact_clear_at.
 * Trigger compaction only while armed and still at/above compact_at.
 */
export function shouldTriggerAutoCompact(
  pressureRatio: number,
  config: CompilerConfig,
  armed: boolean,
): { trigger: boolean; armed: boolean } {
  const { autoCompactAt, autoCompactClearAt, verbatimOnly } =
    resolveCompactionConfig(config);
  if (verbatimOnly) return { trigger: false, armed };

  let nextArmed = armed;
  if (pressureRatio >= autoCompactAt) nextArmed = true;
  else if (pressureRatio < autoCompactClearAt) nextArmed = false;

  return {
    trigger: nextArmed && pressureRatio >= autoCompactAt,
    armed: nextArmed,
  };
}

export function effectiveCompileBudget(
  tokenBudget: number,
  contextWindowTokens: number,
  reservedOutputTokens = 0,
): number {
  const windowBudget = Math.max(0, contextWindowTokens - reservedOutputTokens);
  return Math.max(0, Math.min(tokenBudget, windowBudget));
}
