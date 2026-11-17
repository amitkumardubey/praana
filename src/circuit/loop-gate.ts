import { resolve } from "node:path";
import { toolErrorBaseKey } from "../context-engine/error-tracker.js";
import { isTestCommand } from "../domain/coding-domain.js";
import { detectShellReads } from "../tools/shell-read-detect.js";

export const CIRCUIT_LOOP_PREFIX = "Circuit breaker:";
export const DEFAULT_LOOP_THRESHOLD = 3;

const READ_TOOLS = new Set<string>([
  "read_file",
  "read_and_summarize",
  "search_code",
  "find_files",
  "retrieve_artifact",
  "recall",
  "search_session_log",
  "search_transcript",
  "search_turn_events",
  "git_status",
  "git_diff",
  "git_log",
  "git_branches",
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_completions",
  "lsp_code_actions",
  "code_parse",
  "code_imports",
  "code_symbols",
  "code_definition",
  "code_references",
  "run_tests",
  "web_fetch",
]);

const GIT_READ_SUBCOMMANDS = new Set(["status", "diff", "log", "show", "blame"]);

function isReadOnlyGitShell(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "git") return false;
  const sub = tokens[1];
  return typeof sub === "string" && GIT_READ_SUBCOMMANDS.has(sub);
}

export function isLoopExempt(toolName: string, args: Record<string, unknown>): boolean {
  if (READ_TOOLS.has(toolName)) return true;
  if (toolName === "shell" && typeof args.command === "string") {
    return (
      detectShellReads(args.command) !== null
      || isTestCommand(args.command)
      || isReadOnlyGitShell(args.command)
    );
  }
  return false;
}

export function circuitLoopError(toolName: string): string {
  return `${CIRCUIT_LOOP_PREFIX} ${toolName} with the same arguments repeated or failed 3 times; required: different approach or ask the user.`;
}

export function renderCircuitNotes(notes: string[]): string {
  if (notes.length === 0) return "";
  return ["## Circuit Breakers", "", ...notes.map((n) => `- ${n}`)].join("\n");
}

export type LoopPreResult =
  | { action: "block"; error: string; isError: true }
  | undefined;

export class LoopGate {
  private readonly argHits = new Map<string, number>();
  private readonly errorHits = new Map<string, { count: number; path?: string }>();
  private readonly noted = new Set<string>();
  private readonly noteList: string[] = [];
  private readonly threshold: number;
  private onFirstBlock?: (text: string) => void;

  constructor(opts?: { threshold?: number; onFirstBlock?: (text: string) => void }) {
    this.threshold = opts?.threshold ?? DEFAULT_LOOP_THRESHOLD;
    this.onFirstBlock = opts?.onFirstBlock;
  }

  notes(): string[] {
    return [...this.noteList];
  }

  static fromEvents(
    events: Array<{ kind: string; payload: Record<string, unknown> }>,
    opts?: { threshold?: number; onFirstBlock?: (text: string) => void },
  ): LoopGate {
    const gate = new LoopGate({ threshold: opts?.threshold });
    // Resuming starts a new turn; error streaks are advisory only. Historical
    // calls cannot be replayed exactly (pre-hook blocks, parallel ordering and
    // redacted arguments), so restore notes only, never either counter.
    for (const ev of events) {
      if (ev.kind === "system_note" && ev.payload.type === "circuit_note") {
        const text = typeof ev.payload.text === "string" ? ev.payload.text : "";
        if (text) gate.adoptNote(text);
      }
    }
    gate.onFirstBlock = opts?.onFirstBlock;
    return gate;
  }

  /**
   * Start a new turn: identical-call counts and error streaks both restart, so
   * an old failure never makes a later first failure look like a repeat. The
   * advisory is about consecutive failures within the current work only.
   */
  resetTurn(): void {
    this.argHits.clear();
    this.errorHits.clear();
  }

  private adoptNote(text: string): void {
    if (this.noteList.includes(text)) return;
    this.noteList.push(text);
    this.noted.add(text);
  }

  observePre(toolName: string, args: Record<string, unknown>): LoopPreResult {
    if (isLoopExempt(toolName, args)) return;
    const argsKey = `${toolName}:${JSON.stringify(args)}`;
    const next = (this.argHits.get(argsKey) ?? 0) + 1;
    this.argHits.set(argsKey, next);
    if (next >= this.threshold) {
      this.rememberBlock(argsKey, toolName);
      return { action: "block", error: circuitLoopError(toolName), isError: true };
    }
    return;
  }

  observePost(toolName: string, args: Record<string, unknown>, isError: boolean, cwd = process.cwd()): true | undefined {
    const path = typeof args.path === "string" ? resolve(cwd, args.path) : undefined;
    if (!isError && path && (toolName === "read_file" || toolName === "read_and_summarize")) {
      for (const [key, streak] of this.errorHits) {
        if (streak.path === path) this.errorHits.delete(key);
      }
    }
    if (isLoopExempt(toolName, args)) return;
    const pathKey = path && typeof args.command !== "string" ? path : undefined;
    const key = toolErrorBaseKey(toolName, pathKey ? { ...args, path: pathKey } : args);
    if (!isError) {
      this.errorHits.delete(key);
      return;
    }
    const count = (this.errorHits.get(key)?.count ?? 0) + 1;
    this.errorHits.set(key, { count, path: pathKey });
    if (count >= 2) return true;
  }

  private rememberBlock(key: string, toolName: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    const text = circuitLoopError(toolName);
    this.noteList.push(text);
    this.onFirstBlock?.(text);
  }
}
