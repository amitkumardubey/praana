/**
 * Bottom glance bar formatter — design §5 ambient chrome.
 *
 * Example: ctx 18.4k/128k 14% · wm 3A·1S · skills 1 · in 12k · out 3k · mem on
 */
import chalk from "chalk";
import type { StatusBarInput } from "../../../status-bar.js";
import {
  formatModelStatusLabel,
  formatSessionTokenBreakdown,
  formatTokenCount,
} from "../../../status-bar.js";
import { shouldShowRawParenthetical } from "../../../context-display.js";
import { TUI_STYLE } from "../theme.js";

export interface GlanceFormatOpts {
  showCost: boolean;
}

export function formatTuiGlanceLine(
  input: StatusBarInput,
  opts: GlanceFormatOpts,
): string {
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

  const ctxSeg =
    pct >= 90
      ? TUI_STYLE.error(ctxLabel)
      : pct >= 70
        ? TUI_STYLE.warning(ctxLabel)
        : pct >= 50
          ? chalk.dim(ctxLabel)
          : TUI_STYLE.success(ctxLabel);

  const parts: string[] = [ctxSeg];

  const { active, soft, hard } = input.memoryStats;
  if (active > 0 || soft > 0 || hard > 0) {
    const tiers: string[] = [];
    if (active > 0) tiers.push(`${active}A`);
    if (soft > 0) tiers.push(`${soft}S`);
    if (hard > 0) tiers.push(`${hard}H`);
    parts.push(TUI_STYLE.info(`wm ${tiers.join("·")}`));
  }

  const loadedCount = input.loadedSkills?.length ?? 0;
  const skillsCount = input.skills.length;
  if (skillsCount > 0) {
    parts.push(
      chalk.dim(
        loadedCount > 0 ? `skills ${loadedCount}` : `skills ${skillsCount}`,
      ),
    );
  }

  if (opts.showCost) {
    const breakdown = formatSessionTokenBreakdown(
      input.sessionInputTokens,
      input.sessionOutputTokens,
    );
    if (breakdown) parts.push(chalk.dim(breakdown));
  }

  if (input.thinking) parts.push(chalk.dim("think"));

  if (input.incognito) {
    parts.push(TUI_STYLE.memory("incognito"));
  } else if (input.memoryEnabled) {
    parts.push(TUI_STYLE.success("mem on"));
  } else {
    parts.push(chalk.dim("mem off"));
  }

  if (input.debug) parts.push(chalk.dim("debug"));

  return parts.join(chalk.dim(" · "));
}

/** Identity line for the top chrome bar (design §5). */
export function formatTuiIdentityLine(input: StatusBarInput): string {
  const { provider, modelShort } = formatModelStatusLabel(input.model);
  const modelPart = provider ? `${provider} · ${modelShort}` : modelShort;

  const repo = shortenHome(input.cwd);
  const repoPart = input.branch ? `${repo} · ${input.branch}` : repo;

  return [
    TUI_STYLE.heading("praana"),
    modelPart,
    chalk.dim(repoPart),
  ].join(chalk.dim(" · "));
}

function shortenHome(path: string): string {
  const home = process.env.HOME;
  if (!home) return path;
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}
