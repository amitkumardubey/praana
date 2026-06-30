/**
 * Per-tool glyph map + compact display helpers (design §6).
 */
import { summarizeArgs } from "../../tool-summary.js";
import type { MemoryBannerStats } from "../../ui-events.js";
import { formatModelStatusLabel } from "../../status-bar.js";
import stripAnsi from "strip-ansi";

const UNICODE_ICONS: Record<string, string> = {
  read_file: "◇",
  search_code: "⌕",
  edit_file: "✎",
  write_file: "✚",
  shell: "❯",
  recall: "◆",
  remember: "◆",
  load_skill: "✦",
  // state/memory tools — distinct per action
  create_task: "▸",
  complete_task: "↩",
  decide: "⊛",
  add_note: "≡",
  add_constraint: "⊘",
  hydrate: "⇡",
  soft_unload: "⊟",
  hard_unload: "⊠",
  search_session_log: "⌂",
  retrieve_artifact: "⊞",
};

const ASCII_ICONS: Record<string, string> = {
  read_file: "r·",
  search_code: "s·",
  edit_file: "e·",
  write_file: "w·",
  shell: "$",
  recall: "m·",
  remember: "m·",
  load_skill: "sk",
  create_task: "t>",
  complete_task: "t<",
  decide: "d·",
  add_note: "n·",
  add_constraint: "c·",
  hydrate: "hy",
  soft_unload: "su",
  hard_unload: "hu",
  search_session_log: "sl",
  retrieve_artifact: "ar",
};

const TOOL_SHORT: Record<string, string> = {
  read_file: "read",
  search_code: "search",
  edit_file: "edit",
  write_file: "write",
  shell: "shell",
  recall: "recall",
  remember: "remember",
  load_skill: "skill",
  create_task: "task",
  complete_task: "done",
  decide: "decide",
  add_note: "note",
  add_constraint: "constraint",
  hydrate: "hydrate",
  soft_unload: "unload",
  hard_unload: "drop",
  search_session_log: "log",
  retrieve_artifact: "artifact",
};

export function toolIcon(toolName: string, useUnicode: boolean): string {
  const map = useUnicode ? UNICODE_ICONS : ASCII_ICONS;
  return map[toolName] ?? (useUnicode ? "⚙" : "?·");
}

export interface ToolDisplayInfo {
  icon: string;
  label: string;
  pending: string;
}

export interface ToolDisplayOpts {
  useUnicode?: boolean;
}

function shellShortLabel(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length <= 56) return trimmed;
  const segments = trimmed.split("&&").map((s) => s.trim());
  const last = segments[segments.length - 1] ?? trimmed;
  const short = last.split(/\s+/).slice(0, 5).join(" ");
  return short.length > 52 ? `${short.slice(0, 51)}…` : short;
}

function formatPath(path: unknown): string {
  const value = String(path ?? "");
  if (!value) return "";
  return value.length > 48 ? "…" + value.slice(-45) : value;
}

function toolShortName(toolName: string): string {
  return TOOL_SHORT[toolName] ?? toolName;
}

export function formatToolDisplay(
  toolName: string,
  args: Record<string, unknown>,
  opts: ToolDisplayOpts = {},
): ToolDisplayInfo {
  const useUnicode = opts.useUnicode ?? true;
  const icon = toolIcon(toolName, useUnicode);
  const short = toolShortName(toolName);

  switch (toolName) {
    case "shell": {
      const command = String(args.command ?? "");
      return {
        icon,
        label: command ? shellShortLabel(command) : short,
        pending: "running…",
      };
    }
    case "read_file": {
      const path = formatPath(args.path);
      return { icon, label: path ? `${short}  ${path}` : short, pending: "reading…" };
    }
    case "write_file": {
      const path = formatPath(args.path);
      return { icon, label: path ? `${short}  ${path}` : short, pending: "writing…" };
    }
    case "edit_file": {
      const path = formatPath(args.path);
      return { icon, label: path ? `${short}  ${path}` : short, pending: "editing…" };
    }
    case "search_code": {
      const pattern = String(args.pattern ?? "").slice(0, 40);
      return {
        icon,
        label: pattern ? `${short}  "${pattern}"` : short,
        pending: "searching…",
      };
    }
    case "recall": {
      const query = String(args.query ?? "").slice(0, 60);
      return {
        icon,
        label: query ? `${short}  "${query}"` : short,
        pending: "recalling…",
      };
    }
    case "remember": {
      const content = String(args.content ?? "").slice(0, 50);
      return {
        icon,
        label: content ? `${short}  ${content}` : short,
        pending: "storing…",
      };
    }
    case "load_skill": {
      const id = String(args.skill_id ?? args.name ?? "").slice(0, 40);
      return { icon, label: id ? `${short}  ${id}` : short, pending: "loading…" };
    }
    default: {
      const summary = summarizeArgs(toolName, args);
      return {
        icon,
        label: summary ? `${short}  ${summary}` : short,
        pending: "running…",
      };
    }
  }
}

/** Diff line counts for edit_file results (+added −removed). */
export function formatEditDiffSummary(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  const oldText = String(args.oldText ?? "");
  const newText = String(args.newText ?? "");
  if (!oldText && !newText) return null;
  const added = newText ? newText.split("\n").length : 0;
  const removed = oldText ? oldText.split("\n").length : 0;
  return `+${added} −${removed}`;
}

/** Compact shell result: pass/fail counts when detectable, else exit code. */
export function formatShellCompactSummary(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const stdout = stripAnsi(String(parsed.stdout ?? ""));
    const exitCode = typeof parsed.exitCode === "number" ? parsed.exitCode : 0;

    const passMatch = stdout.match(/(\d+)\s+pass/i);
    const failMatch = stdout.match(/(\d+)\s+fail/i);
    if (passMatch || failMatch) {
      const pass = passMatch?.[1] ?? "0";
      const fail = failMatch?.[1] ?? "0";
      return `${pass} pass · ${fail} fail`;
    }

    const testsMatch = stdout.match(/(\d+)\s+tests?\s+passed/i);
    if (testsMatch) {
      return `${testsMatch[1]} pass · 0 fail`;
    }

    if (exitCode === 0) return "ok";
    return `exit ${exitCode}`;
  } catch {
    return summarizeResultForDisplay(text);
  }
}

export function summarizeResultForDisplay(text: string): string {
  if (!text) return "(empty)";

  const artifactMatch = text.match(/\[artifact:\s*(art_[a-f0-9]+)/i);
  if (artifactMatch) {
    const tokenMatch = text.match(/([\d,]+)\s*tokens?\b/i);
    const id = artifactMatch[1]!;
    return tokenMatch
      ? `artifact ${id.slice(0, 12)}… · ${tokenMatch[1]!.replace(/,/g, "")} tok`
      : `artifact ${id.slice(0, 16)}…`;
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.stdout === "string" || typeof parsed.stderr === "string") {
      return formatShellCompactSummary(text);
    }
    if (parsed.ok === false) {
      return `error: ${String(parsed.error ?? "failed").slice(0, 60)}`;
    }
    if (typeof parsed.content === "string") {
      const content = parsed.content;
      const lineCount = content.split("\n").length;
      const preview = content.split("\n")[0]?.slice(0, 48) ?? "";
      return `${lineCount} lines · ${preview}${content.length > 48 ? "…" : ""}`;
    }
    if (parsed.id) {
      return `ok · ${String(parsed.id).slice(0, 24)}`;
    }
    if (parsed.ok === true) {
      return "ok";
    }
  } catch {
    /* plain text */
  }

  const lines = text.split("\n").length;
  const preview = text.slice(0, 120).split("\n")[0]!;
  const previewText = preview.length > 56 ? `${preview.slice(0, 55)}…` : preview;
  return lines > 1 ? `${lines} lines — ${previewText}` : previewText;
}

const SHELL_OUTPUT_MAX_LINES = 24;
const SHELL_OUTPUT_MAX_CHARS = 3072;

export interface ShellOutputDisplay {
  summary: string;
  body: string | null;
  isError: boolean;
}

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
    const summary = formatShellCompactSummary(text);

    const bodyParts: string[] = [];
    if (stdout) bodyParts.push(stdout);
    if (stderr) {
      bodyParts.push(
        stderr.split("\n").map((line) => `[stderr] ${line}`).join("\n"),
      );
    }

    const fullBody = bodyParts.join("\n");
    if (!fullBody) {
      return { summary, body: null, isError: exitCode !== 0 };
    }

    const lines = fullBody.split("\n");
    let body = fullBody;
    if (lines.length > SHELL_OUTPUT_MAX_LINES || body.length > SHELL_OUTPUT_MAX_CHARS) {
      body = lines.slice(0, SHELL_OUTPUT_MAX_LINES).join("\n");
      if (body.length > SHELL_OUTPUT_MAX_CHARS) {
        body = body.slice(0, SHELL_OUTPUT_MAX_CHARS);
      }
      const remaining = lines.length - SHELL_OUTPUT_MAX_LINES;
      if (remaining > 0) {
        body += `\n… +${remaining} more lines`;
      }
    }

    return { summary, body, isError: exitCode !== 0 };
  } catch {
    return null;
  }
}

export interface TurnFooterInput {
  durationMs: number;
  stats?: MemoryBannerStats;
  ambient: "inline" | "quiet";
  editCount: number;
  writeCount: number;
  ctxBeforePct: number;
  ctxAfterPct: number;
  /** Active model label for this turn (e.g. "opencode/big-pickle"). */
  model?: string;
}

/** Dim one-line turn digest (design §5). */
export function formatTurnFooterDigest(input: TurnFooterInput): string {
  const parts: string[] = [];

  const fileEdits = input.editCount + input.writeCount;
  if (fileEdits > 0) {
    parts.push(`${fileEdits} edit${fileEdits === 1 ? "" : "s"}`);
  }

  if (input.ctxAfterPct > 0 || input.ctxBeforePct > 0) {
    if (input.ctxBeforePct > 0 && input.ctxBeforePct !== input.ctxAfterPct) {
      parts.push(`ctx ${input.ctxBeforePct}%→${input.ctxAfterPct}%`);
    } else {
      parts.push(`ctx ${input.ctxAfterPct}%`);
    }
  }

  if (input.stats && input.stats.recallCalls > 0) {
    if (input.ambient === "quiet") {
      parts.push(`recall ${input.stats.recallHits || input.stats.recallCalls}`);
    } else if (input.stats.recallHits > 0) {
      parts.push(`recall ${input.stats.recallHits}`);
    }
  }

  // Compact model label: strip routing prefix, show provider·model.
  if (input.model) {
    const { provider, modelShort } = formatModelStatusLabel(input.model);
    parts.push(provider ? `${provider}·${modelShort}` : modelShort);
  }

  const duration =
    input.durationMs < 1000
      ? `${Math.max(0, Math.round(input.durationMs))}ms`
      : `${(input.durationMs / 1000).toFixed(1)}s`;

  if (parts.length === 0) {
    return `✓ · ${duration}`;
  }

  return `✓ ${parts.join(" · ")} · ${duration}`;
}

/** @deprecated Use formatTurnFooterDigest */
export function formatTurnStatsSuffix(stats?: MemoryBannerStats): string {
  if (!stats) return "";
  const parts: string[] = [];
  if (stats.promptTokens > 0) parts.push(`prompt ~${fmtToken(stats.promptTokens)}`);
  if (stats.outputTokens > 0) parts.push(`out ~${fmtToken(stats.outputTokens)}`);
  if (stats.recallCalls > 0) {
    parts.push(`recall ${stats.recallHits}/${stats.recallCalls}`);
  }
  return parts.join(" · ");
}

function fmtToken(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
