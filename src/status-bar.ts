/**
 * Session status bar rendered above the readline prompt (stderr).
 * Surfaces model, context usage, mode, repo, memory tiers, skills, and current task.
 */

import { basename } from "node:path";
import chalk from "chalk";
import type { CompileMetrics } from "./compiler.js";
import type { Session } from "./session.js";
import type { StateGraph } from "./state-graph.js";
import type { TaskPayload } from "./types.js";

/** Default model context window when provider metadata is unavailable. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface StatusBarInput {
  model: string;
  repoPath: string;
  cwd: string;
  debug: boolean;
  thinking: boolean;
  memoryEnabled: boolean;
  incognito: boolean;
  contextUsedTokens: number;
  contextWindowTokens: number;
  memoryStats: { active: number; soft: number; hard: number };
  skills: string[];
  skillResidency: { hot: number; warm: number; total: number } | null;
  currentTask: string | null;
  agentsContextLoaded: boolean;
}

/** Split an active model label into provider + short model name for the status bar. */
export function formatModelStatusLabel(model: string): {
  provider: string | null;
  modelShort: string;
} {
  const parts = model.split("/");
  if (parts.length >= 2) {
    return {
      provider: parts[0],
      modelShort: parts[parts.length - 1],
    };
  }
  return { provider: null, modelShort: model };
}

/** Format token counts for compact display (e.g. 18400 → "18.4k"). */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    if (k >= 100 && Number.isInteger(k)) return `${k}k`;
    if (k >= 100) return `${Math.round(k)}k`;
    const fixed = k.toFixed(1);
    return `${fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed}k`;
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** Short repo label: git root folder name, or cwd folder name. */
export function formatRepoLabel(repoPath: string, cwd: string): string {
  const rootName = basename(repoPath);
  const cwdName = basename(cwd);
  if (repoPath === cwd || rootName === cwdName) return rootName;
  return `${rootName}/${cwdName}`;
}

/** Mode string for the status bar (debug + thinking visibility). */
export function formatMode(debug: boolean, thinking: boolean): string {
  if (debug && thinking) return "debug+think";
  if (debug) return "debug";
  if (!thinking) return "normal·think-off";
  return "normal";
}

/** Pick the current task title: doing first, then oldest todo. */
export function getCurrentTaskTitle(stateGraph: StateGraph): string | null {
  const tasks = stateGraph
    .list()
    .filter((o) => o.kind === "task")
    .map((o) => {
      const obj = stateGraph.get(o.id);
      return obj ? (obj.payload as TaskPayload) : null;
    })
    .filter((p): p is TaskPayload => p !== null);

  const doing = tasks.find((t) => t.status === "doing");
  if (doing) return doing.title;

  const todo = tasks.find((t) => t.status === "todo");
  return todo?.title ?? null;
}

export function buildStatusBarInput(
  session: Session,
  opts: {
    model: string;
    debug: boolean;
    thinking: boolean;
    contextWindowTokens?: number;
    compileMetrics?: CompileMetrics | null;
  }
): StatusBarInput {
  const mem = session.getMemoryStats();
  const metrics = opts.compileMetrics ?? session.getLastCompileMetrics();
  const agentsContextTokens = session.agentsContext
    ? Math.ceil(session.agentsContext.length / 4)
    : 0;
  const skillResidency = session.skillRuntime?.getResidencyCounts();
  return {
    model: opts.model,
    repoPath: session.getRepoRoot(),
    cwd: session.cwd,
    debug: opts.debug,
    thinking: opts.thinking,
    memoryEnabled: session.memoryEnabled,
    incognito: session.isIncognito(),
    contextUsedTokens: metrics?.totalTokens ?? agentsContextTokens,
    contextWindowTokens: opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW,
    memoryStats: { active: mem.active, soft: mem.soft, hard: mem.hard },
    skills: (session.skills ?? []).map((s) => s.name),
    skillResidency: skillResidency
      ? { hot: skillResidency.hot, warm: skillResidency.warm, total: skillResidency.hot + skillResidency.warm + skillResidency.cold }
      : null,
    currentTask: getCurrentTaskTitle(session.stateGraph),
    agentsContextLoaded: !!session.agentsContext,
  };
}

/** Render status bar lines (no trailing newline on last line — caller adds newline). */
export function formatStatusBarLines(input: StatusBarInput): string[] {
  const ctx = `${formatTokenCount(input.contextUsedTokens)} / ${formatTokenCount(input.contextWindowTokens)}`;
  const repo = formatRepoLabel(input.repoPath, input.cwd);
  const memFlag = input.incognito
    ? chalk.magenta("incognito")
    : input.memoryEnabled
      ? chalk.green("on")
      : chalk.dim("off");
  const agents = input.agentsContextLoaded ? chalk.dim("· AGENTS.md") : "";

  const line1 = [
    chalk.cyan(input.model.split("/").pop() ?? input.model),
    chalk.dim(ctx),
    chalk.yellow(formatMode(input.debug, input.thinking)),
    chalk.blue(repo),
    `memory ${memFlag}${agents}`,
  ].join(chalk.dim(" · "));

  const line2 = [
    chalk.bold("Memory:"),
    `${input.memoryStats.active} active`,
    `${input.memoryStats.soft} soft`,
    `${input.memoryStats.hard} hard`,
  ].join(chalk.dim(" · "));

  const line3 = [chalk.bold("Context:"), ctx].join(" ");

  const skillsLabel =
    input.skills.length > 0
      ? `${input.skills.length} skills (${input.skillResidency ? `${input.skillResidency.hot} HOT · ${input.skillResidency.warm} WARM · ${input.skillResidency.total - input.skillResidency.hot - input.skillResidency.warm} COLD` : "?/?/? loaded"})`
      : chalk.dim("(none — add skills/*.md to project root)");
  const line4 = [chalk.bold("Skills:"), skillsLabel].join(" ");

  const taskLabel = input.currentTask
    ? chalk.white(input.currentTask)
    : chalk.dim("(none — create_task)");
  const line5 = [chalk.bold("Current task:"), taskLabel].join(" ");

  return [line1, line2, line3, line4, line5];
}

/** Write the status bar to stderr (no-op when not a TTY). */
export function renderStatusBar(input: StatusBarInput): void {
  if (!process.stderr.isTTY) return;
  const width = process.stderr.columns ?? 80;
  const lines = formatStatusBarLines(input).map((line) => truncateAnsiLine(line, width));
  for (const line of lines) {
    process.stderr.write(line + "\n");
  }
}

/** One-line emoji status bar — compact with pipe separators. */
export function formatEmojiStatusLine(input: StatusBarInput): string {
  const { provider, modelShort } = formatModelStatusLabel(input.model);
  const modelLabel = provider ? `${provider} · ${modelShort}` : modelShort;
  const pct = input.contextWindowTokens > 0
    ? Math.min(100, Math.round((input.contextUsedTokens / input.contextWindowTokens) * 100))
    : 0;
  const memStr = input.incognito ? "incognito" : input.memoryEnabled ? "on" : "off";
  const skillsCount = input.skills.length;
  let stateStr = "";
  if (input.memoryStats && (input.memoryStats.active > 0 || input.memoryStats.soft > 0 || input.memoryStats.hard > 0)) {
    const parts: string[] = [];
    if (input.memoryStats.active > 0) parts.push(`${input.memoryStats.active}A`);
    if (input.memoryStats.soft > 0) parts.push(`${input.memoryStats.soft}S`);
    if (input.memoryStats.hard > 0) parts.push(`${input.memoryStats.hard}H`);
    stateStr = parts.join("/");
  }
  const parts = [
    chalk.cyan(`📦 model: ${modelLabel}`),
    pct > 90 ? chalk.red(`🧠 ctx: ${pct}%`) : pct > 70 ? chalk.yellow(`🧠 ctx: ${pct}%`) : chalk.dim(`🧠 ctx: ${pct}%`),
    memStr === "on" ? chalk.green(`💾 mem: ${memStr}`) : chalk.dim(`💾 mem: ${memStr}`),
  ];
  if (skillsCount > 0) {
    parts.push(chalk.magenta(`🛠️  ${skillsCount}sk${stateStr ? ` [${stateStr}]` : ""}`));
  } else if (stateStr) {
    parts.push(chalk.magenta(`🛠️  [${stateStr}]`));
  }
  if (input.currentTask) {
    parts.push(chalk.dim(`🎯 ${input.currentTask}`));
  }
  return parts.join(chalk.dim("  |  "));
}

function truncateAnsiLine(line: string, maxWidth: number): string {
  const visible = stripAnsi(line);
  if (visible.length <= maxWidth) return line;
  const suffix = "…";
  const target = Math.max(10, maxWidth - suffix.length);
  let cut = 0;
  let vis = 0;
  while (cut < line.length && vis < target) {
    if (line[cut] === "\x1b") {
      const end = line.indexOf("m", cut);
      cut = end >= 0 ? end + 1 : cut + 1;
      continue;
    }
    cut++;
    vis++;
  }
  return line.slice(0, cut) + chalk.dim(suffix);
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
