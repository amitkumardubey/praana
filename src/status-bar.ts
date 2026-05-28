/**
 * Session status bar rendered above the readline prompt (stderr).
 * Surfaces model, context usage, mode, repo, memory tiers, skills, and current task.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";
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
  contextUsedTokens: number;
  contextWindowTokens: number;
  memoryStats: { active: number; soft: number; hard: number };
  skills: string[];
  currentTask: string | null;
  agentsContextLoaded: boolean;
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

/**
 * Discover project-local skill names for display (not yet injected into prompts).
 * Scans skills/*.md and .cursor/skills/<name>/SKILL.md under git root.
 */
export function discoverLoadedSkills(cwd: string): string[] {
  const gitRoot = findGitRoot(cwd);
  const names = new Set<string>();

  const skillsDir = join(gitRoot, "skills");
  if (existsSync(skillsDir)) {
    try {
      for (const ent of readdirSync(skillsDir, { withFileTypes: true })) {
        if (ent.isFile() && ent.name.endsWith(".md")) {
          names.add(ent.name.replace(/\.md$/i, ""));
        }
        if (ent.isDirectory()) {
          const skillFile = join(skillsDir, ent.name, "SKILL.md");
          if (existsSync(skillFile)) names.add(ent.name);
        }
      }
    } catch {
      /* unreadable */
    }
  }

  const cursorSkills = join(gitRoot, ".cursor", "skills");
  if (existsSync(cursorSkills)) {
    try {
      for (const ent of readdirSync(cursorSkills, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        const skillFile = join(cursorSkills, ent.name, "SKILL.md");
        if (existsSync(skillFile)) names.add(ent.name);
      }
    } catch {
      /* unreadable */
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b)).slice(0, 8);
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
  return {
    model: opts.model,
    repoPath: session.getRepoRoot(),
    cwd: session.cwd,
    debug: opts.debug,
    thinking: opts.thinking,
    memoryEnabled: session.memoryEnabled,
    contextUsedTokens: metrics?.totalTokens ?? 0,
    contextWindowTokens: opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW,
    memoryStats: { active: mem.active, soft: mem.soft, hard: mem.hard },
    skills: discoverLoadedSkills(session.cwd),
    currentTask: getCurrentTaskTitle(session.stateGraph),
    agentsContextLoaded: !!session.agentsContext,
  };
}

/** Render status bar lines (no trailing newline on last line — caller adds newline). */
export function formatStatusBarLines(input: StatusBarInput): string[] {
  const ctx = `${formatTokenCount(input.contextUsedTokens)} / ${formatTokenCount(input.contextWindowTokens)}`;
  const repo = formatRepoLabel(input.repoPath, input.cwd);
  const memFlag = input.memoryEnabled ? chalk.green("on") : chalk.dim("off");
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
      ? input.skills.join(", ")
      : chalk.dim("(none — add skills/*.md or .cursor/skills/)");
  const line4 = [chalk.bold("Loaded skills:"), skillsLabel].join(" ");

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

function findGitRoot(cwd: string): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}
