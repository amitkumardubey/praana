import { toolErrorBaseKey } from "../context-engine/error-tracker.js";
import { isTestCommand } from "../domain/coding-domain.js";
import { detectShellReads } from "../tools/shell-read-detect.js";

export const CIRCUIT_LOOP_PREFIX = "Circuit breaker:";
export const DEFAULT_LOOP_THRESHOLD = 3;

const READ_TOOLS = new Set<string>([
  "read_file",
  "read_and_summarize",
  "search_code",
  "retrieve_artifact",
  "recall",
  "search_session_log",
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
  private readonly errorHits = new Map<string, number>();
  private readonly noted = new Set<string>();
  private readonly noteList: string[] = [];
  private readonly threshold: number;
  private readonly onFirstBlock?: (text: string) => void;

  constructor(opts?: { threshold?: number; onFirstBlock?: (text: string) => void }) {
    this.threshold = opts?.threshold ?? DEFAULT_LOOP_THRESHOLD;
    this.onFirstBlock = opts?.onFirstBlock;
  }

  notes(): string[] {
    return [...this.noteList];
  }

  observePre(toolName: string, args: Record<string, unknown>): LoopPreResult {
    if (isLoopExempt(toolName, args)) return;
    const argsKey = `${toolName}:${JSON.stringify(args)}`;
    const baseKey = toolErrorBaseKey(toolName, args);
    const next = (this.argHits.get(argsKey) ?? 0) + 1;
    this.argHits.set(argsKey, next);
    const errors = this.errorHits.get(baseKey) ?? 0;
    if (next >= this.threshold || errors >= this.threshold - 1) {
      this.rememberBlock(next >= this.threshold ? argsKey : baseKey, toolName);
      return { action: "block", error: circuitLoopError(toolName), isError: true };
    }
    return;
  }

  observePost(toolName: string, args: Record<string, unknown>, isError: boolean): void {
    if (!isError || isLoopExempt(toolName, args)) return;
    const key = toolErrorBaseKey(toolName, args);
    this.errorHits.set(key, (this.errorHits.get(key) ?? 0) + 1);
  }

  private rememberBlock(key: string, toolName: string): void {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    const text = circuitLoopError(toolName);
    this.noteList.push(text);
    this.onFirstBlock?.(text);
  }
}
