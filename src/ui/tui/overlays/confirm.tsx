/**
 * Minimal confirm overlay. It carries two modes.
 *
 * `step` is the per-turn step pause: Enter continues, Esc stops and asks for
 * a summary. `yesno` asks a risk or web_fetch question: `y` accepts and
 * `n`, Enter, and Esc decline.
 *
 * In both modes keys are ignored until `CONFIRM_ARM_MS` has passed, so a key
 * that closed the previous overlay cannot answer this one. Ctrl+C is never
 * part of that window and is not consumed: the global handler aborts the
 * turn, and the abort signal settles the confirm as false.
 *
 * Other keys are swallowed while the overlay is open. The key intercept
 * re-binds when the prompt changes, so a second confirm arms its keys again
 * even when this component stays mounted.
 */
import { createEffect, onCleanup } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useKeymap } from "@opentui/keymap/solid";
import { OverlayFrame, overlayFrameMaxHeight, OVERLAY_FRAME_CHROME_ROWS } from "./frame.js";
import { TUI_STYLE } from "../theme.js";
import type { ConfirmMode, OverlayUi } from "./state.js";

/** How long a freshly opened confirm ignores its answer keys. */
export const CONFIRM_ARM_MS = 100;

export const CONFIRM_HINT = "Enter = continue · Esc = stop and summarise · Ctrl+C = abort";

export const CONFIRM_YESNO_HINT = "y = yes · n / Enter / Esc = no · Ctrl+C = abort";

export interface ConfirmOverlayProps {
  overlay: OverlayUi;
  /** Override the arm delay in tests. Defaults to `CONFIRM_ARM_MS`. */
  armMs?: number;
}

export type StepPauseKeyAction = "continue" | "stop" | "ignore" | "passthrough";

export type YesNoKeyAction = "yes" | "no" | "ignore" | "passthrough";

/**
 * Key policy for the step-pause confirm. `passthrough` is not consumed, so
 * the global Ctrl+C handler can abort the turn.
 */
export function classifyStepPauseKey(name: string, ctrl: boolean, armed: boolean): StepPauseKeyAction {
  if (name === "c" && ctrl) return "passthrough";
  if (!armed) return "ignore";
  if (name === "escape" || name === "esc") return "stop";
  if (name === "enter" || name === "return") return "continue";
  return "ignore";
}

/**
 * Key policy for a yes/no risk confirm. `y` accepts; `n`, Enter, and Esc
 * decline. Every other key is swallowed while the overlay is open, except
 * Ctrl+C, which passes through so the global handler can abort the turn.
 */
export function classifyYesNoKey(name: string, ctrl: boolean, armed: boolean): YesNoKeyAction {
  if (name.toLowerCase() === "c" && ctrl) return "passthrough";
  if (!armed) return "ignore";
  if (ctrl) return "ignore";
  const key = name.toLowerCase();
  if (key === "y") return "yes";
  if (key === "n" || key === "enter" || key === "return" || key === "escape" || key === "esc") {
    return "no";
  }
  return "ignore";
}

/** The question without the terminal-only `[y/N]` suffix that readline appended. */
export function formatConfirmQuestion(message: string, mode: ConfirmMode): string {
  if (mode !== "yesno") return message;
  return message.replace(/\s*\[y\/N\]\s*$/i, "");
}

/** Rows the hint line occupies; it is never elided. */
export const CONFIRM_HINT_ROWS = 1;

/**
 * Preview rows that fit for a terminal height, keeping the question, the blank
 * separator, and the hint on screen. Also used to size the session-side cap.
 */
export function confirmPreviewRows(termHeight: number, questionLines = 1, messageRows?: number): number {
  const frame = overlayFrameMaxHeight(termHeight, messageRows);
  const inner = frame - OVERLAY_FRAME_CHROME_ROWS;
  // One blank row separates the question from the preview.
  return Math.max(0, inner - CONFIRM_HINT_ROWS - questionLines - 1);
}

/**
 * Split a prompt that carries a preview from its question. `edit_file` and
 * `git_commit` (#748) send `preview lines`, a blank line, then the question,
 * because the session handler is a plain string shared with risk prompts. The
 * overlay pins the question so a long diff cannot push it out of the frame.
 * A message without that separator is all question, so risk prompts are
 * unchanged.
 */
export function splitConfirmMessage(message: string): { preview: string[]; question: string } {
  const at = message.lastIndexOf("\n\n");
  if (at === -1) return { preview: [], question: message };
  const question = message.slice(at + 2);
  if (question.trim().length === 0) return { preview: [], question: message };
  const preview = message.slice(0, at).split("\n");
  while (preview.length > 0 && preview[preview.length - 1] === "") preview.pop();
  return { preview, question };
}

/**
 * Cap the preview to the rows left in the frame. The last kept row becomes a
 * count so the reader knows the preview was elided rather than truncated.
 */
export function capConfirmPreview(preview: readonly string[], rows: number): string[] {
  if (rows <= 0) return [];
  if (preview.length <= rows) return [...preview];
  const keep = Math.max(0, rows - 1);
  return [...preview.slice(0, keep), `... ${preview.length - keep} more lines`];
}

function confirmHint(mode: ConfirmMode): string {
  return mode === "yesno" ? CONFIRM_YESNO_HINT : CONFIRM_HINT;
}

export function ConfirmOverlay(props: ConfirmOverlayProps) {
  const keymap = useKeymap();
  const dimensions = useTerminalDimensions();

  // Re-bind when the prompt changes, including when this component stays mounted.
  createEffect(() => {
    const prompt = props.overlay.confirmPrompt();
    if (!prompt) return;
    const mode = prompt.mode;
    const armedAt = Date.now() + (props.armMs ?? CONFIRM_ARM_MS);
    const off = keymap.intercept("key", (ctx) => {
      const e = ctx.event;
      const armed = Date.now() >= armedAt;
      const action =
        mode === "yesno"
          ? classifyYesNoKey(e.name, !!e.ctrl, armed)
          : classifyStepPauseKey(e.name, !!e.ctrl, armed);
      if (action === "passthrough") return;
      ctx.consume({ preventDefault: true, stopPropagation: true });
      if (action === "yes" || action === "continue") props.overlay.resolveConfirm(true);
      else if (action === "no" || action === "stop") props.overlay.resolveConfirm(false);
    });
    onCleanup(off);
  });

  const prompt = () => props.overlay.confirmPrompt();
  const parsed = () => splitConfirmMessage(prompt()?.message ?? "");
  const previewRows = () =>
    confirmPreviewRows(
      dimensions().height,
      parsed().question.split("\n").length,
    );
  const previewLines = () => capConfirmPreview(parsed().preview, previewRows());
  const question = () => formatConfirmQuestion(parsed().question, prompt()?.mode ?? "step");

  return (
    <OverlayFrame width={64}>
      <text>{question()}</text>
      {previewLines().map((line) => (
        <text>
          <span style={TUI_STYLE.muted}>{line.length === 0 ? " " : line}</span>
        </text>
      ))}
      <text><span style={TUI_STYLE.muted}>{confirmHint(prompt()?.mode ?? "step")}</span></text>
    </OverlayFrame>
  );
}
