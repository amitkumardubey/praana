/**
 * Bottom glance + identity chrome formatters — launch-screen lock.
 *
 * Identity: muted `praana · provider/model · cwd · branch`
 * Glance: split metrics (left) + green on-flags (right)
 */
import type { StatusBarInput } from "../../../status-bar.js";
import {
  formatModelStatusLabel,
  formatSessionTokenBreakdown,
  formatTokenCount,
} from "../../../status-bar.js";
import { shouldShowRawParenthetical } from "../../../context-display.js";
import { TUI_STYLE, type SpanStyle, type TextSegment } from "../theme.js";

export interface GlanceFormatOpts {
  showCost: boolean;
}

/** Mid-dot separator between chrome sections. */
const SEPARATOR: TextSegment = { text: " · ", style: TUI_STYLE.chromeMuted };

function seg(text: string, style?: SpanStyle): TextSegment {
  return style ? { text, style } : { text };
}

export interface GlanceParts {
  metrics: TextSegment[];
  flags: TextSegment[];
}

function ctxPercent(input: StatusBarInput): number {
  const engineMode = input.contextDisplayMode === "engine";
  if (engineMode) {
    return (
      input.contextWeightedPct ??
      (input.contextUsedTokens > 0 && input.contextWindowTokens > 0
        ? Math.min(
            100,
            Math.round((input.contextUsedTokens / input.contextWindowTokens) * 100),
          )
        : 0)
    );
  }
  return input.contextWindowTokens > 0
    ? Math.min(
        100,
        Math.round((input.contextUsedTokens / input.contextWindowTokens) * 100),
      )
    : 0;
}

function formatCtxLabel(input: StatusBarInput, pct: number): string {
  const engineMode = input.contextDisplayMode === "engine";
  if (input.contextWindowTokens > 0) {
    const pctSuffix = engineMode ? `${pct}%w` : `${pct}%`;
    let ctxLabel = `ctx ${formatTokenCount(input.contextUsedTokens)}/${formatTokenCount(input.contextWindowTokens)} ${pctSuffix}`;
    if (
      engineMode &&
      input.contextRawPct !== undefined &&
      shouldShowRawParenthetical(pct, input.contextRawPct)
    ) {
      ctxLabel += ` (${input.contextRawPct}% raw)`;
    }
    if (
      engineMode &&
      input.contextPressureMode &&
      input.contextPressureMode !== "normal"
    ) {
      ctxLabel += ` · ${input.contextPressureMode}`;
    }
    return ctxLabel;
  }
  return engineMode ? `ctx ${pct}%w` : `ctx ${pct}%`;
}

function ctxStyleFor(pct: number): SpanStyle {
  // Escalate only under pressure; otherwise stay ambient muted.
  if (pct >= 90) return TUI_STYLE.error;
  if (pct >= 70) return TUI_STYLE.warning;
  return TUI_STYLE.chromeMuted;
}

/** Split glance parts for the locked chrome layout. */
export function formatTuiGlanceParts(
  input: StatusBarInput,
  opts: GlanceFormatOpts,
): GlanceParts {
  const pct = ctxPercent(input);
  const metrics: TextSegment[] = [seg(formatCtxLabel(input, pct), ctxStyleFor(pct))];

  const { active, soft, hard } = input.memoryStats;
  if (active > 0 || soft > 0 || hard > 0) {
    const tiers: string[] = [];
    if (active > 0) tiers.push(`${active}A`);
    if (soft > 0) tiers.push(`${soft}S`);
    if (hard > 0) tiers.push(`${hard}H`);
    metrics.push(seg(`wm ${tiers.join("·")}`, TUI_STYLE.chromeMuted));
  }

  const loadedCount = input.loadedSkills?.length ?? 0;
  const skillsCount = input.skills.length;
  if (skillsCount > 0) {
    metrics.push(
      seg(
        loadedCount > 0 ? `skills ${loadedCount}` : `skills ${skillsCount}`,
        TUI_STYLE.chromeMuted,
      ),
    );
  }

  if (opts.showCost) {
    const breakdown = formatSessionTokenBreakdown(
      input.sessionInputTokens,
      input.sessionOutputTokens,
    );
    if (breakdown) metrics.push(seg(breakdown, TUI_STYLE.chromeMuted));
  }

  if (input.thinking || input.reasoningEffort) {
    const effort = input.reasoningEffort?.trim();
    if (input.thinking && effort) {
      metrics.push(seg(`think ${effort}`, TUI_STYLE.chromeMuted));
    } else if (input.thinking) {
      metrics.push(seg("think", TUI_STYLE.chromeMuted));
    } else if (effort) {
      metrics.push(seg(`think ${effort}`, TUI_STYLE.chromeMuted));
    }
  }

  if (input.debug) metrics.push(seg("debug", TUI_STYLE.chromeMuted));
  if (input.planMode) metrics.push(seg("plan", TUI_STYLE.warning));

  const flags: TextSegment[] = [];
  if (input.contextEngineEnabled) {
    flags.push(seg("engine on", TUI_STYLE.onFlag));
  }
  if (input.incognito) {
    flags.push(seg("incognito", TUI_STYLE.memory));
  } else if (input.memoryEnabled) {
    flags.push(seg("mem on", TUI_STYLE.onFlag));
  } else {
    flags.push(seg("mem off", TUI_STYLE.chromeMuted));
  }
  if (input.updateRestart) {
    flags.push(seg("restart", TUI_STYLE.warning));
  } else if (input.updateAvailable) {
    flags.push(seg("update", TUI_STYLE.warning));
  }

  return {
    metrics: interleave(metrics, SEPARATOR),
    flags: interleave(flags, SEPARATOR),
  };
}

/** Flat glance line (metrics then flags) for tests and non-split consumers. */
export function formatTuiGlanceLine(
  input: StatusBarInput,
  opts: GlanceFormatOpts,
): TextSegment[] {
  const { metrics, flags } = formatTuiGlanceParts(input, opts);
  if (flags.length === 0) return metrics;
  if (metrics.length === 0) return flags;
  return [...metrics, SEPARATOR, ...flags];
}

/** Identity line — muted slash-model row (launch lock). */
export function formatTuiIdentityLine(input: StatusBarInput): TextSegment[] {
  const { provider, modelShort } = formatModelStatusLabel(input.model);
  const modelPart = provider ? `${provider}/${modelShort}` : modelShort;
  const repo = shortenHome(input.cwd);

  const parts: TextSegment[] = [
    seg("praana", TUI_STYLE.chromeMuted),
    seg(modelPart, TUI_STYLE.chromeMuted),
    seg(repo, TUI_STYLE.chromeMuted),
  ];
  if (input.branch) {
    parts.push(seg(input.branch, TUI_STYLE.chromeMuted));
  }

  return interleave(parts, SEPARATOR);
}

function interleave(parts: TextSegment[], separator: TextSegment): TextSegment[] {
  const out: TextSegment[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) out.push(separator);
    out.push(parts[i]!);
  }
  return out;
}

function shortenHome(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}
