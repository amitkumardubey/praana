import { summarizeArgs } from "../../tool-summary.js";
import type { MemoryBannerStats } from "../../ui-events.js";
import stripAnsi from "strip-ansi";
function fmtToken(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface ToolDisplayInfo {
  icon: string;
  label: string;
  pending: string;
}

function shellShortLabel(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length <= 64) return trimmed;
  const segments = trimmed.split("&&").map((s) => s.trim());
  const last = segments[segments.length - 1] ?? trimmed;
  const short = last.split(/\s+/).slice(0, 4).join(" ");
  return short.length > 56 ? `${short.slice(0, 55)}…` : short;
}

/** Produce a compact one-line summary of a tool result for display. */
export function summarizeResultForDisplay(text: string): string {
  if (!text) return "(empty)";

  const artifactMatch = text.match(/\[artifact:\s*(art_[a-f0-9]+)/i);
  if (artifactMatch) {
    const tokenMatch = text.match(/([\d,]+)\s*tokens?\b/i);
    const id = artifactMatch[1]!;
    return tokenMatch
      ? `artifact ${id.slice(0, 12)}… · ${tokenMatch[1]!.replace(/,/g, "")} tokens`
      : `artifact ${id.slice(0, 16)}…`;
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.stdout === "string" || typeof parsed.stderr === "string") {
      const stdout = stripAnsi(String(parsed.stdout ?? "")).trimEnd();
      const stderr = stripAnsi(String(parsed.stderr ?? "")).trimEnd();
      const primary = stdout || stderr;
      const lineCount = primary ? primary.split("\n").filter(Boolean).length : 0;
      const preview = primary.split("\n")[0]?.slice(0, 56) ?? "";
      const suffix = preview ? ` — ${preview}${primary.length > 56 ? "…" : ""}` : "";
      return `exit ${parsed.exitCode ?? 0} · ${lineCount} line(s)${suffix}`;
    }
    if (parsed.ok === false) {
      return `error: ${String(parsed.error ?? "failed").slice(0, 72)}`;
    }
    if (typeof parsed.content === "string") {
      const content = parsed.content;
      const lineCount = content.split("\n").length;
      const preview = content.split("\n")[0]?.slice(0, 56) ?? "";
      return `${lineCount} line(s) · ${preview}${content.length > 56 ? "…" : ""}`;
    }
    if (parsed.id) {
      return `ok · ${String(parsed.id).slice(0, 28)}`;
    }
  } catch {
    /* plain text */
  }

  const lines = text.split("\n").length;
  const chars = text.length;
  const preview = text.slice(0, 200).split("\n")[0]!;
  const previewText = preview.length > 72 ? `${preview.slice(0, 71)}…` : preview;
  const size = lines > 1 ? `${lines} lines, ${chars} chars` : `${chars} chars`;
  return `${size} — ${previewText}`;
}

/**
 * Shell output truncation limits for TUI transcript display.
 * These are hardcoded for now; could be made configurable via config file in the future.
 */
const SHELL_OUTPUT_MAX_LINES = 30;
const SHELL_OUTPUT_MAX_CHARS = 4096;

export interface ShellOutputDisplay {
  summary: string;
  body: string | null;
  isError: boolean;
}

/** Format shell tool JSON result for TUI transcript display. */
export function formatShellOutputForDisplay(text: string): ShellOutputDisplay | null {
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.stdout !== "string" && typeof parsed.stderr !== "string") {
      return null;
    }

    const stdout = stripAnsi(String(parsed.stdout ?? "")).trimEnd();
    const stderr = stripAnsi(String(parsed.stderr ?? "")).trimEnd();
    const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : 0;
    const summary = summarizeResultForDisplay(text);

    const bodyParts: string[] = [];
    if (stdout) bodyParts.push(stdout);
    if (stderr) {
      bodyParts.push(stderr.split("\n").map((line) => `[stderr] ${line}`).join("\n"));
    }

    const fullBody = bodyParts.join("\n");
    if (!fullBody) {
      return { summary, body: null, isError: exitCode !== 0 };
    }

    const lines = fullBody.split("\n");
    let body = fullBody;
    if (lines.length > SHELL_OUTPUT_MAX_LINES || body.length > SHELL_OUTPUT_MAX_CHARS) {
      const truncatedLines = lines.slice(0, SHELL_OUTPUT_MAX_LINES);
      const joined = truncatedLines.join("\n");
      body = joined;
      const charTruncated = body.length > SHELL_OUTPUT_MAX_CHARS;
      if (charTruncated) {
        body = body.slice(0, SHELL_OUTPUT_MAX_CHARS);
      }
      const remaining = lines.length - truncatedLines.length;
      const suffixParts: string[] = [];
      if (remaining > 0) {
        suffixParts.push(`+${remaining} more line${remaining === 1 ? "" : "s"}`);
      }
      if (charTruncated) {
        suffixParts.push("truncated");
      }
      if (suffixParts.length > 0) {
        body += `\n… ${suffixParts.join(", ")}`;
      }
    }

    return {
      summary,
      body,
      isError: exitCode !== 0,
    };
  } catch {
    return null;
  }
}

function formatPath(path: unknown): string {
  const value = String(path ?? "");
  if (!value) return "";
  return value.length > 60 ? "…" + value.slice(-57) : value;
}

export function formatToolDisplay(
  toolName: string,
  args: Record<string, unknown>
): ToolDisplayInfo {
  switch (toolName) {
    case "shell": {
      const command = String(args.command ?? "");
      return {
        icon: "$",
        label: command ? shellShortLabel(command) : "shell",
        pending: "Running command…",
      };
    }
    case "retrieve_artifact": {
      const id = String(args.id ?? args.artifact_id ?? "").slice(0, 16);
      return {
        icon: "◆",
        label: id ? `Artifact ${id}` : "Retrieve artifact",
        pending: "Retrieving artifact…",
      };
    }
    case "read_file": {
      const path = formatPath(args.path);
      return { icon: "→", label: `Read ${path}`, pending: "Reading file…" };
    }
    case "write_file": {
      const path = formatPath(args.path);
      return { icon: "←", label: `Write ${path}`, pending: "Writing file…" };
    }
    case "edit_file": {
      const path = formatPath(args.path);
      return { icon: "✎", label: `Edit ${path}`, pending: "Editing file…" };
    }
    case "search_code": {
      const pattern = String(args.pattern ?? "");
      const path = args.path ? ` in ${formatPath(args.path)}` : "";
      return {
        icon: "✱",
        label: `Grep "${pattern}"${path}`,
        pending: "Searching…",
      };
    }
    case "recall": {
      const query = String(args.query ?? "").slice(0, 80);
      return { icon: "◈", label: `Recall "${query}"`, pending: "Recalling…" };
    }
    case "search_session_log": {
      const query = String(args.query ?? "").slice(0, 80);
      return { icon: "◈", label: `Search log "${query}"`, pending: "Searching log…" };
    }
    case "create_task": {
      const title = String(args.title ?? "").slice(0, 80);
      return { icon: "◇", label: `Task ${title}`, pending: "Creating task…" };
    }
    case "complete_task":
    case "hydrate":
    case "soft_unload":
    case "hard_unload": {
      const id = String(args.id ?? "").slice(0, 26);
      return { icon: "◇", label: `${toolName} ${id}`, pending: "Updating state…" };
    }
    case "remember": {
      const content = String(args.content ?? "").slice(0, 60);
      return { icon: "◈", label: `Remember ${content}`, pending: "Storing memory…" };
    }
    default: {
      const summary = summarizeArgs(toolName, args);
      return {
        icon: "⚙",
        label: summary ? `${toolName} ${summary}` : toolName,
        pending: "Running…",
      };
    }
  }
}

/** Turn-specific stats for the footer (excludes state — tier counts live in the status bar). */
export function formatTurnStatsSuffix(stats?: MemoryBannerStats): string {
  if (!stats) return "";
  const parts: string[] = [];
  if (stats.promptTokens > 0) parts.push(`prompt ~${fmtToken(stats.promptTokens)}`);
  if (stats.outputTokens > 0) parts.push(`out ~${fmtToken(stats.outputTokens)}`);
  if (stats.digestLen > 0) parts.push(`digest ${stats.digestLen}c`);
  if (stats.recallCalls > 0) {
    parts.push(`recall ${stats.recallHits}/${stats.recallCalls}`);
  }
  if (stats.autoHydrated > 0) parts.push(`auto+${stats.autoHydrated}`);
  return parts.join(" · ");
}

export function formatTurnFooter(
  model: string,
  durationMs: number,
  stats?: MemoryBannerStats
): string {
  const modelShort = model.split("/").pop() ?? model;
  const duration =
    durationMs < 1000
      ? `${Math.max(0, Math.round(durationMs))}ms`
      : `${(durationMs / 1000).toFixed(1)}s`;
  const parts = [`▣ PRAANA`, modelShort, duration];
  const suffix = formatTurnStatsSuffix(stats);
  if (suffix) parts.push(suffix);
  return parts.join(" · ");
}

/** Compact boot summary for the TUI welcome panel. */
export function formatTuiBootSummary(input: {
  sessionId: string;
  contextTokens?: number;
  engineEnabled: boolean;
  skillCount: number;
  memoryEnabled: boolean;
  incognito: boolean;
}): string {
  const parts: string[] = [`session ${input.sessionId}`];
  if (input.contextTokens && input.contextTokens > 0) {
    parts.push(`ctx ~${input.contextTokens} tok`);
  }
  if (input.engineEnabled) parts.push("engine on");
  if (input.skillCount > 0) {
    parts.push(`${input.skillCount} skill${input.skillCount === 1 ? "" : "s"}`);
  }
  if (input.incognito) parts.push("incognito");
  else if (!input.memoryEnabled) {
    parts.push("mem off (enable memory.enabled in config)");
  }
  return parts.join(" · ");
}

const BLOCK_ROLES = new Set([
  "user",
  "assistant",
  "tool",
  "tool_result",
  "thinking",
  "turn_footer",
  "system",
]);

/** Whether this entry should have extra top margin (visual break from prior block). */
export function needsTopMargin(
  role: string,
  prevRole: string | undefined
): boolean {
  if (role === "user") return true;
  if (!prevRole) return false;
  if (role === prevRole) return false;
  if (role === "turn_footer") return true;
  if (role === "thinking" && prevRole !== "thinking") return true;
  if (
    role === "tool" &&
    prevRole !== "tool" &&
    prevRole !== "tool_result"
  ) {
    return true;
  }
  if (role === "assistant" && BLOCK_ROLES.has(prevRole)) {
    return true;
  }
  return false;
}
