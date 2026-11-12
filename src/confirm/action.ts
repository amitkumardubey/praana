/**
 * Confirmations for whole tool actions (`edit_file`, `git_commit`) rather than
 * risk classes (#748).
 *
 * Both tools preview what they are about to do before asking. The TUI renders
 * the question in the overlay, so the preview has to travel inside the prompt
 * text the handler receives: plain strings, no ANSI, capped so a large diff
 * cannot push the question out of the overlay. The classic terminal path keeps
 * the coloured stderr preview it always had and then asks the question.
 */
import chalk from "chalk";
import { writeUiStderr } from "../ui.js";

/** How the classic stderr preview colours a line. */
export type PreviewTone = "dim" | "remove" | "add" | "accent" | "plain";

export interface PreviewLine {
  /** One line, or a multi-line block (a git diff stat, for example). */
  text: string;
  tone: PreviewTone;
}

/** Which tool asked; only used to word the refusal. */
export type ActionKind = "edit" | "commit";

/** One action confirmation: the preview, then the question. */
export interface ActionConfirmRequest {
  /** Question line; the overlay strips the terminal-only `[y/N]` suffix. */
  question: string;
  /** Plain-text preview lines (header, changes, message/stat), no ANSI. */
  preview: readonly PreviewLine[];
}

/**
 * Outcome of an action confirmation. Same shape as `RiskConfirmResult` but
 * kept separate so the tools take no dependency on risk classes: an action
 * confirmation has no class id and no `[risk].allow` override.
 */
export type ActionConfirmResult =
  | { allowed: true }
  | { allowed: false; reason: "declined" | "headless" };

/**
 * The session confirmation the tools call: `Session.confirmAction`. Taken as a
 * callback so the tools never read stdin — in the TUI OpenTUI owns it.
 */
export type ActionConfirmHandler = (request: ActionConfirmRequest) => Promise<ActionConfirmResult>;

/** Preview lines kept in the overlay text before the rest is summarised. */
export const ACTION_PREVIEW_MAX_LINES = 40;

const TONE_STYLE = {
  dim: (line: string) => chalk.dim(line),
  remove: (line: string) => chalk.red(line),
  add: (line: string) => chalk.green(line),
  accent: (line: string) => chalk.cyan(line),
  plain: (line: string) => line,
} satisfies Record<PreviewTone, (line: string) => string>;

const CANCELLED = {
  edit: "Edit cancelled by user",
  commit: "Commit cancelled by user",
} satisfies Record<ActionKind, string>;

const HEADLESS = {
  edit: "Edit not applied: confirmation required but the session is headless",
  commit: "Commit not created: confirmation required but the session is headless",
} satisfies Record<ActionKind, string>;

const UNPROMPTABLE = {
  edit: "Edit not applied: confirmation required but no confirmation handler is installed",
  commit: "Commit not created: confirmation required but no confirmation handler is installed",
} satisfies Record<ActionKind, string>;

/**
 * Cap the preview for the overlay, which has a fixed height. The last kept
 * line becomes a count, so the question below it stays visible and the reader
 * knows text was elided.
 */
export function capPreviewLines(
  lines: readonly string[],
  maxLines: number = ACTION_PREVIEW_MAX_LINES,
): string[] {
  if (lines.length <= maxLines) return [...lines];
  const keep = Math.max(0, maxLines - 1);
  const dropped = lines.length - keep;
  return [...lines.slice(0, keep), `... ${dropped} more lines`];
}

/** Plain prompt text for the UI handler: capped preview, blank line, question. */
export function formatActionConfirmPrompt(
  request: ActionConfirmRequest,
  maxLines: number = ACTION_PREVIEW_MAX_LINES,
): string {
  const preview = capPreviewLines(
    request.preview.flatMap((line) => line.text.split("\n")),
    maxLines,
  );
  if (preview.length === 0) return request.question;
  return `${preview.join("\n")}\n\n${request.question}`;
}

/** Classic terminal preview: today's coloured stderr output, before the question. */
export function writeActionConfirmPreview(request: ActionConfirmRequest): void {
  // Both tools always opened the preview with a blank line; keep that so a
  // classic session sees the same layout as before.
  writeUiStderr("");
  for (const line of request.preview) {
    writeUiStderr(TONE_STYLE[line.tone](line.text));
  }
}

/**
 * Error for a refused confirmation. A real "no" keeps the wording the tools
 * always returned; a refusal we could not ask about says why. `null` means the
 * tool has no confirmation callback wired at all.
 */
export function actionRefusalError(
  kind: ActionKind,
  decision: ActionConfirmResult | null,
): string {
  if (decision === null) return UNPROMPTABLE[kind];
  if (decision.allowed) return "";
  if (decision.reason === "declined") return CANCELLED[kind];
  return HEADLESS[kind];
}
