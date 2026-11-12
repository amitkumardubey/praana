/**
 * Confirmations for whole tool actions (`edit_file`, `git_commit`) rather than
 * risk classes (#748).
 *
 * Both tools preview what they are about to do before asking. The preview
 * travels to the UI as structured data next to the question — never joined
 * into the prompt text — so the overlay can budget rows for it and the
 * question is always exactly the question. Plain strings, no ANSI: OpenTUI
 * renders them. The classic terminal path keeps the coloured stderr preview
 * it always had and then asks the question.
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

/**
 * Extra data the confirm handler takes beside the question. `preview` is the
 * action preview (see `ActionConfirmRequest`), rendered by the UI next to the
 * question rather than inside it. Risk prompts pass no options at all.
 */
export interface ConfirmHandlerOptions {
  readonly preview?: readonly string[];
}

/**
 * The installed UI confirmation: a question, plus the structured preview when
 * the caller has one. A prompt that carries a preview must not encode it in
 * the message text — a risk detail can contain blank lines (a heredoc), and
 * guessing the split from the string truncated the command the user was
 * approving.
 */
export type ConfirmHandler = (
  prompt: string,
  options?: ConfirmHandlerOptions,
) => Promise<boolean>;

/**
 * Hard bound on preview lines kept in overlay text. The overlay caps to the
 * rows it actually has; this only stops a pathological diff from being copied
 * into the overlay state. When it bites, it retains both ends and a count.
 */
export const ACTION_PREVIEW_MAX_LINES = 400;

/** Unsafe terminal controls, invisible formatting and bidi controls; tabs and newlines are handled separately. */
const UNSAFE_PREVIEW_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

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
 * Plain preview lines for the UI handler: one row per line, multi-line blocks
 * split, no ANSI. The session passes the full preview so the overlay makes the
 * row-budget cap from the real frame height; a separate hard limit here
 * bounds pathological diffs while retaining both ends and a count.
 */
export function actionPreviewLines(request: ActionConfirmRequest): string[] {
  // Replace terminal controls visibly; newline has already separated the rows.
  const lines = request.preview.flatMap((line) =>
    line.text.split("\n").map((row) => row.replace(/\r$/, "␍").replace(UNSAFE_PREVIEW_CHARACTERS, "·")),
  );
  if (lines.length <= ACTION_PREVIEW_MAX_LINES) return lines;
  const keep = ACTION_PREVIEW_MAX_LINES - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return [...lines.slice(0, head), `... ${lines.length - keep} more lines`, ...lines.slice(-tail)];
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
  if (decision.allowed) throw new Error("Cannot refuse an allowed action");
  if (decision.reason === "declined") return CANCELLED[kind];
  return HEADLESS[kind];
}
