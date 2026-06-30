/**
 * Bottom glance bar formatter — design §5 ambient chrome.
 *
 * Example: ctx 43% · state 3A·1S · skills 1 · ~12k tok · think · mem on
 */
import chalk from "chalk";
import type { StatusBarInput } from "../../../status-bar.js";
import { formatModelStatusLabel } from "../../../status-bar.js";
import { TUI_STYLE } from "../theme.js";

export interface GlanceFormatOpts {
  showCost: boolean;
  sessionInputTokens?: number;
  sessionOutputTokens?: number;
}

export function formatTuiGlanceLine(
  input: StatusBarInput,
  opts: GlanceFormatOpts,
): string {
  const pct =
    input.contextWindowTokens > 0
      ? Math.min(
          100,
          Math.round((input.contextUsedTokens / input.contextWindowTokens) * 100),
        )
      : 0;

  const ctxSeg =
    pct >= 90
      ? TUI_STYLE.error(`ctx ${pct}%`)
      : pct >= 70
        ? TUI_STYLE.warning(`ctx ${pct}%`)
        : pct >= 50
          ? chalk.dim(`ctx ${pct}%`)
          : TUI_STYLE.success(`ctx ${pct}%`);

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
    const inTok = opts.sessionInputTokens ?? 0;
    const outTok = opts.sessionOutputTokens ?? 0;
    const total = inTok + outTok;
    if (total > 0) {
      parts.push(chalk.dim(`~${formatCompactTokens(total)} tok`));
    }
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

function formatCompactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}
