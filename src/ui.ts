/**
 * Terminal UI helpers for ARIA.
 * Tool/status output goes to stderr; stdout gets blank-line breaks so
 * agent text and debug blocks don't run together in the terminal.
 *
 * Color output is managed via chalk (respects NO_COLOR / non-TTY automatically).
 * Spinner (ora) is only activated when stderr is a real TTY.
 */

import chalk from "chalk";
import ora, { type Ora } from "ora";

type UiWriters = {
  stderr: (line: string) => void;
  breakStdout: () => void;
};

const defaultWriters: UiWriters = {
  stderr: (line: string) => process.stderr.write(line),
  breakStdout: () => process.stdout.write("\n"),
};

let writers: UiWriters = defaultWriters;

let activeSpinner: Ora | null = null;

function stderr(line: string): void {
  writers.stderr(line);
}

/** Break the agent text flow on stdout before/after ancillary output. */
function breakStdout(): void {
  writers.breakStdout();
}

export function setUiWriters(overrides?: Partial<UiWriters>): void {
  if (!overrides) {
    writers = defaultWriters;
    return;
  }
  writers = {
    stderr: overrides.stderr ?? defaultWriters.stderr,
    breakStdout: overrides.breakStdout ?? defaultWriters.breakStdout,
  };
}

/**
 * Start a spinner on stderr with the given text.
 * No-op when stderr is not a TTY (tests, CI, piped output).
 */
export function startSpinner(text: string): void {
  if (!process.stderr.isTTY) return;
  stopSpinner();
  activeSpinner = ora({ text, stream: process.stderr }).start();
}

/**
 * Stop and clear the active spinner.
 * Safe to call when no spinner is running.
 */
export function stopSpinner(): void {
  if (!activeSpinner) return;
  activeSpinner.stop();
  activeSpinner = null;
}

function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return String(args.path ?? "");
    case "shell":
      return String(args.command ?? "").slice(0, 80);
    case "create_task":
      return String(args.title ?? "");
    case "complete_task":
    case "hydrate":
    case "soft_unload":
    case "hard_unload":
      return String(args.id ?? "").slice(0, 26);
    case "add_constraint":
    case "add_note":
      return String(args.text ?? "").slice(0, 60);
    case "decide":
      return String(args.summary ?? "").slice(0, 60);
    case "recall":
      return String(args.query ?? "").slice(0, 60);
    case "remember":
      return String(args.content ?? "").slice(0, 60);
    default:
      return Object.entries(args)
        .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 40)}`)
        .join(", ")
        .slice(0, 80);
  }
}

function summarizeResult(result: unknown): string {
  if (result === null || result === undefined) return "done";
  if (typeof result !== "object") return String(result).slice(0, 120);

  const r = result as Record<string, unknown>;
  if (r.ok === false && r.error) return `error: ${String(r.error).slice(0, 100)}`;
  if (r.ok === true || r.ok === undefined) {
    if (typeof r.stdout === "string" && r.stdout.length > 0) {
      const lines = r.stdout.trim().split("\n").length;
      return `exit ${r.exitCode ?? 0}, ${lines} line(s)`;
    }
    if (typeof r.content === "string") {
      return `${r.content.length} chars`;
    }
    if (typeof r.output === "string") {
      return r.output.slice(0, 100);
    }
    if (r.id) return `id ${String(r.id).slice(0, 26)}`;
  }
  return JSON.stringify(result).slice(0, 100);
}

/** Compact tool indicator — shown in normal mode. */
export function printToolCall(toolName: string, args: Record<string, unknown>): void {
  breakStdout();
  const summary = summarizeArgs(toolName, args);
  stderr(
    `\n${chalk.dim("[tool]")} ${chalk.cyan(toolName)}${summary ? ` ${chalk.dim(`:: ${summary}`)}` : ""}\n`
  );
  breakStdout();
}

/** Debug block header before a batch of tool calls in a step. */
export function printToolBlockStart(stepIndex: number): void {
  breakStdout();
  stderr(
    `\n${chalk.yellow("[debug]")} ${chalk.dim(`┌ step ${stepIndex} tool execution ${"─".repeat(18)}┐`)}\n`
  );
}

/** Debug tool call with full args. */
export function printToolCallDebug(
  toolName: string,
  args: Record<string, unknown>
): void {
  const argsJson = JSON.stringify(args);
  const display = argsJson.length > 200 ? argsJson.slice(0, 197) + "..." : argsJson;
  stderr(`  ${chalk.yellow(">")} ${toolName}(${display})\n`);
}

/** Debug tool result. */
export function printToolResultDebug(toolName: string, result: unknown): void {
  const summary = summarizeResult(result);
  stderr(`  ${chalk.green("<")} ${toolName} ${chalk.dim(summary)}\n`);
}

/** Debug block footer. */
export function printToolBlockEnd(): void {
  stderr(`${chalk.dim(`└${"─".repeat(46)}┘`)}\n`);
  breakStdout();
}

/** General debug message (prompt saved, etc.). */
export function printDebug(message: string): void {
  stderr(`\n${chalk.yellow("[debug]")} ${message}\n`);
  breakStdout();
}

/** Compact per-turn memory banner after each response. */
export function printMemoryBanner(stats: {
  activeState: number;
  totalState: number;
  digestLen: number;
  recallCalls: number;
  recallHits: number;
  autoHydrated: number;
  promptTokens?: number;
}): void {
  if (
    stats.activeState === 0 &&
    stats.recallCalls === 0 &&
    stats.autoHydrated === 0 &&
    stats.digestLen === 0 &&
    !stats.promptTokens
  ) return;
  const parts: string[] = [];
  if (stats.activeState > 0 || stats.totalState > 0) parts.push(`${stats.activeState}/${stats.totalState} state`);
  if (stats.digestLen > 0) parts.push(`digest ${stats.digestLen}c`);
  if (stats.recallCalls > 0) parts.push(`recall ${stats.recallHits}h`);
  if (stats.autoHydrated > 0) parts.push(`auto+${stats.autoHydrated}`);
  if (stats.promptTokens && stats.promptTokens > 0) parts.push(`prompt ~${stats.promptTokens}t`);
  if (parts.length === 0) return;
  stderr(`\n${chalk.dim(`[state] ${parts.join(" | ")}`)}\n`);
}
