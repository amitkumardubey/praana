/**
 * Context pressure numbers for glance bar and turn footer.
 * Single source of truth for UI context fill estimates.
 */
import type { CompileMetrics } from "./compiler.js";
import type { PressureMode } from "./context-engine/types.js";
import type { Session } from "./session.js";
import { estimateTokens } from "./token-estimate.js";

export const RAW_DIVERGENCE_THRESHOLD_PP = 15;
export const DISTILLER_FOOTER_MIN_SAVINGS = 1000;

export type ContextDisplayMode = "classic" | "engine";

export interface ContextDisplaySnapshot {
  usedTokens: number;
  windowTokens: number;
  pct: number;
  mode: ContextDisplayMode;
  weightedTokens?: number;
  weightedPct?: number;
  rawTokens?: number;
  rawPct?: number;
  pressureMode?: PressureMode;
  historyTokens?: number;
  distillerSavingsTurn?: number;
}

export interface ContextHistoryDelta {
  tokensAdded: number;
  source: "assistant" | "tool";
  distillerSavings?: number;
}

export function contextPct(usedTokens: number, windowTokens: number): number {
  if (windowTokens <= 0) return 0;
  return Math.min(100, Math.round((usedTokens / windowTokens) * 100));
}

export function shouldShowRawParenthetical(
  weightedPct: number,
  rawPct: number,
): boolean {
  return rawPct - weightedPct > RAW_DIVERGENCE_THRESHOLD_PP;
}

function systemBases(
  metrics: CompileMetrics | null,
  engineMode: boolean,
  weightedSystem: number,
): { rawSystem: number; weightedSystem: number } {
  const rawSystem = metrics?.totalTokens ?? 0;
  return {
    rawSystem,
    weightedSystem: engineMode ? weightedSystem : rawSystem,
  };
}

export function buildContextDisplaySnapshot(input: {
  session: Session;
  contextWindowTokens: number;
  engineMode: boolean;
  historyTokens?: number;
  distillerSavingsTurn?: number;
}): ContextDisplaySnapshot {
  const metrics = input.session.getLastCompileMetrics();
  const historyTokens = input.historyTokens ?? 0;
  const { rawSystem, weightedSystem } = systemBases(
    metrics,
    input.engineMode,
    input.session.getLastWeightedTokens(),
  );

  const usedTokens = weightedSystem + historyTokens;
  const rawTokens = rawSystem + historyTokens;
  const windowTokens = input.contextWindowTokens;
  const weightedPct = contextPct(usedTokens, windowTokens);
  const rawPct = contextPct(rawTokens, windowTokens);

  if (!input.engineMode) {
    return {
      usedTokens: rawTokens,
      windowTokens,
      pct: rawPct,
      mode: "classic",
      historyTokens,
      distillerSavingsTurn: input.distillerSavingsTurn,
    };
  }

  return {
    usedTokens,
    windowTokens,
    pct: weightedPct,
    mode: "engine",
    weightedTokens: usedTokens,
    weightedPct,
    rawTokens,
    rawPct,
    pressureMode: input.session.getLastPressureMode(),
    historyTokens,
    distillerSavingsTurn: input.distillerSavingsTurn,
  };
}

export function buildCommittedContextSnapshot(
  session: Session,
  contextWindowTokens: number,
  engineMode: boolean,
): ContextDisplaySnapshot | null {
  const committed = session.getDisplayContextSnapshot();
  if (committed) {
    return {
      ...committed,
      windowTokens: contextWindowTokens,
      pct: contextPct(committed.usedTokens, contextWindowTokens),
      weightedPct: committed.weightedPct !== undefined
        ? contextPct(committed.usedTokens, contextWindowTokens)
        : undefined,
      rawPct: committed.rawTokens !== undefined
        ? contextPct(committed.rawTokens, contextWindowTokens)
        : undefined,
    };
  }
  const metrics = session.getLastCompileMetrics();
  if (!metrics && !session.agentsContext) return null;
  return buildContextDisplaySnapshot({
    session,
    contextWindowTokens,
    engineMode,
    historyTokens: 0,
  });
}

/** Serialize pi-ai assistant message content for token estimation. */
export function estimateAssistantMessageTokens(message: unknown): number {
  if (typeof message !== "object" || message === null) return 0;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return estimateTokens(content);
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") text += b.text;
      if (typeof b.thinking === "string") text += b.thinking;
      if (typeof b.name === "string") text += b.name;
      if (b.arguments !== undefined) {
        text += typeof b.arguments === "string"
          ? b.arguments
          : JSON.stringify(b.arguments);
      }
    }
    return estimateTokens(text);
  }
  return estimateTokens(JSON.stringify(message));
}

export function computeDistillerSavings(
  rawText: string,
  promptText: string,
  inlined: boolean,
): number {
  if (inlined) return 0;
  const raw = estimateTokens(rawText);
  const distilled = estimateTokens(promptText);
  return Math.max(0, raw - distilled);
}

/** Keep the higher used-token snapshot (monotonic end-of-turn commit). */
export function maxContextSnapshot(
  built: ContextDisplaySnapshot,
  live: ContextDisplaySnapshot | null | undefined,
): ContextDisplaySnapshot {
  if (!live || live.usedTokens <= built.usedTokens) return built;
  const windowTokens = built.windowTokens;
  return {
    ...live,
    windowTokens,
    pct: contextPct(live.usedTokens, windowTokens),
    weightedPct: live.weightedPct !== undefined
      ? contextPct(live.usedTokens, windowTokens)
      : undefined,
    rawPct: live.rawTokens !== undefined
      ? contextPct(live.rawTokens, windowTokens)
      : undefined,
    distillerSavingsTurn: built.distillerSavingsTurn ?? live.distillerSavingsTurn,
  };
}

export function mergeContextPreview(
  baseline: ContextDisplaySnapshot,
  historyTokens: number,
  distillerSavingsTurn: number,
  engineMode: boolean,
): ContextDisplaySnapshot {
  const metricsHistory = historyTokens;
  const rawSystem =
    (baseline.rawTokens ?? baseline.usedTokens) -
    (baseline.historyTokens ?? 0);
  const weightedSystem =
    (baseline.weightedTokens ?? baseline.usedTokens) -
    (baseline.historyTokens ?? 0);

  if (!engineMode) {
    const usedTokens = rawSystem + metricsHistory;
    return {
      ...baseline,
      usedTokens,
      pct: contextPct(usedTokens, baseline.windowTokens),
      historyTokens: metricsHistory,
      distillerSavingsTurn,
    };
  }

  const usedTokens = weightedSystem + metricsHistory;
  const rawTokens = rawSystem + metricsHistory;
  return {
    ...baseline,
    usedTokens,
    weightedTokens: usedTokens,
    rawTokens,
    pct: contextPct(usedTokens, baseline.windowTokens),
    weightedPct: contextPct(usedTokens, baseline.windowTokens),
    rawPct: contextPct(rawTokens, baseline.windowTokens),
    historyTokens: metricsHistory,
    distillerSavingsTurn,
  };
}
