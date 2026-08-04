/**
 * Bottom glance bar formatter — design §5 ambient chrome.
 *
 * Returns styled text segments (native OpenTUI styling, no ANSI) instead of
 * a pre-composed string. Consumers render each segment as
 * `<span style={seg.style}>{seg.text}</span>` inside a single `<text>`.
 *
 * Example segments: [ctx 18.4k/128k 14%] · [wm 3A·1S] · [skills 1] · [in 12k] · [out 3k] · [mem on]
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

const SEPARATOR: TextSegment = { text: " · ", style: TUI_STYLE.faint };

function seg(text: string, style?: SpanStyle): TextSegment {
  return style ? { text, style } : { text };
}

export function formatTuiGlanceLine(
  input: StatusBarInput,
  opts: GlanceFormatOpts,
): TextSegment[] {
  const engineMode = input.contextDisplayMode === "engine";
  const pct = engineMode
    ? (input.contextWeightedPct ??
        (input.contextUsedTokens > 0 && input.contextWindowTokens > 0
          ? Math.min(
              100,
              Math.round((input.contextUsedTokens / input.contextWindowTokens) * 100),
            )
          : 0))
    : input.contextWindowTokens > 0
      ? Math.min(
          100,
          Math.round((input.contextUsedTokens / input.contextWindowTokens) * 100),
        )
      : 0;

  let ctxLabel: string;
  if (input.contextWindowTokens > 0) {
    const pctSuffix = engineMode ? `${pct}%w` : `${pct}%`;
    ctxLabel = `ctx ${formatTokenCount(input.contextUsedTokens)}/${formatTokenCount(input.contextWindowTokens)} ${pctSuffix}`;
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
  } else {
    ctxLabel = engineMode ? `ctx ${pct}%w` : `ctx ${pct}%`;
  }

  const ctxStyle: SpanStyle =
    pct >= 90
      ? TUI_STYLE.error
      : pct >= 70
        ? TUI_STYLE.warning
        : pct >= 50
          ? TUI_STYLE.faint
          : TUI_STYLE.success;

  const parts: TextSegment[] = [seg(ctxLabel, ctxStyle)];

  const { active, soft, hard } = input.memoryStats;
  if (active > 0 || soft > 0 || hard > 0) {
    const tiers: string[] = [];
    if (active > 0) tiers.push(`${active}A`);
    if (soft > 0) tiers.push(`${soft}S`);
    if (hard > 0) tiers.push(`${hard}H`);
    parts.push(seg(`wm ${tiers.join("·")}`, TUI_STYLE.info));
  }

  const loadedCount = input.loadedSkills?.length ?? 0;
  const skillsCount = input.skills.length;
  if (skillsCount > 0) {
    parts.push(
      seg(loadedCount > 0 ? `skills ${loadedCount}` : `skills ${skillsCount}`, TUI_STYLE.faint),
    );
  }

  if (opts.showCost) {
    const breakdown = formatSessionTokenBreakdown(
      input.sessionInputTokens,
      input.sessionOutputTokens,
    );
    if (breakdown) parts.push(seg(breakdown, TUI_STYLE.faint));
  }

  if (input.thinking) parts.push(seg("think", TUI_STYLE.faint));
  if (input.reasoningEffort) {
    parts.push(seg(`effort ${input.reasoningEffort}`, TUI_STYLE.faint));
  }

  if (input.incognito) {
    parts.push(seg("incognito", TUI_STYLE.memory));
  } else if (input.memoryEnabled) {
    parts.push(seg("mem on", TUI_STYLE.success));
  } else {
    parts.push(seg("mem off", TUI_STYLE.faint));
  }

  if (input.debug) parts.push(seg("debug", TUI_STYLE.faint));
  if (input.planMode) parts.push(seg("plan", TUI_STYLE.warning));

  return interleave(parts, SEPARATOR);
}

/** Identity line for the top chrome bar (design §5). */
export function formatTuiIdentityLine(input: StatusBarInput): TextSegment[] {
  const { provider, modelShort } = formatModelStatusLabel(input.model);
  const modelPart = provider ? `${provider} · ${modelShort}` : modelShort;

  const repo = shortenHome(input.cwd);
  const repoPart = input.branch ? `${repo} · ${input.branch}` : repo;

  return interleave(
    [seg("praana", TUI_STYLE.heading), seg(modelPart), seg(repoPart, TUI_STYLE.faint)],
    SEPARATOR,
  );
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
