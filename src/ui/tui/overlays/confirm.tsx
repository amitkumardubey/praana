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
import { createEffect, For, onCleanup, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useKeymap } from "@opentui/keymap/solid";
import {
  OverlayFrame,
  overlayFrameInnerWidth,
  OVERLAY_FRAME_CHROME_ROWS,
} from "./frame.js";
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

/** Columns the confirm frame asks for; the frame clamps it to the terminal. */
export const CONFIRM_FRAME_WIDTH = 64;

/** Rows the hint line occupies; it is never elided. */
export const CONFIRM_HINT_ROWS = 1;

/** Preview rows a preview-carrying prompt gets when the terminal has them. */
export const CONFIRM_MIN_PREVIEW_ROWS = 3;

/**
 * Frame height for a confirm. A prompt that carries a preview may use two more
 * rows than the usual cap so a short terminal still has room to show the thing
 * being approved. Risk and step prompts keep the frame they always had.
 */
export function confirmFrameMaxHeight(termHeight: number, hasPreview: boolean): number {
  const height = Math.max(8, termHeight || 24);
  return hasPreview ? Math.max(8, height - 2) : Math.max(8, height - 6);
}

/**
 * Preview rows that fit for a terminal height, keeping the question, the blank
 * separator, and the hint on screen.
 * `hasPreview` selects the frame a preview-carrying prompt gets.
 */
export function confirmPreviewRows(
  termHeight: number,
  questionLines = 1,
  hasPreview = false,
): number {
  const frame = confirmFrameMaxHeight(termHeight, hasPreview);
  const inner = frame - OVERLAY_FRAME_CHROME_ROWS;
  // One blank row separates the question from the preview.
  return Math.max(0, inner - CONFIRM_HINT_ROWS - questionLines - 1);
}

/**
 * Cap the preview to the rows left in the frame, retaining both ends and a
 * count so the reader knows the preview was elided rather than truncated.
 * The caller supplies rows from the real frame height; exceptionally large
 * inputs may already have been bounded before reaching the overlay.
 */
export function capConfirmPreview(preview: readonly string[], rows: number): string[] {
  if (rows <= 0) return [];
  if (preview.length <= rows) return [...preview];
  const keep = rows - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return [...preview.slice(0, head), `... ${preview.length - keep} more lines`, ...(tail ? preview.slice(-tail) : [])];
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate preview rows to the frame's inner width. The row budget is one
 * terminal row per preview line, so a long diff line, commit subject, or
 * `--stat` path that wraps would spend two rows and push the question and hint
 * out of the frame. Tabs are expanded first: the terminal advances them to a
 * stop, which would otherwise widen the row past what was measured.
 */
export function fitPreviewRows(
  preview: readonly string[],
  innerWidth: number,
): string[] {
  return preview.map((line) => {
    const expanded = expandTabs(line);
    if (Bun.stringWidth(expanded) <= innerWidth) return expanded;
    let fitted = "";
    let width = 0;
    for (const { segment } of GRAPHEME_SEGMENTER.segment(expanded)) {
      const columns = Bun.stringWidth(segment);
      if (width + columns > innerWidth - 1) break;
      fitted += segment;
      width += columns;
    }
    return `${fitted}…`;
  });
}

/** Cap before fitting so hidden rows never incur width processing. */
export function visiblePreviewRows(
  preview: readonly string[],
  rows: number,
  innerWidth: number,
  fit: typeof fitPreviewRows = fitPreviewRows,
): string[] {
  return fit(capConfirmPreview(preview, rows), innerWidth);
}

/** Expand a tab to the next 4-column stop, matching nothing in particular but keeping width predictable. */
function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  const TAB_WIDTH = 4;
  let out = "";
  let width = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(line)) {
    if (segment === "\t") {
      const spaces = TAB_WIDTH - (width % TAB_WIDTH);
      out += " ".repeat(spaces);
      width += spaces;
    } else {
      out += segment;
      width += Bun.stringWidth(segment);
    }
  }
  return out;
}

/** Shown instead of a preview the terminal is too short to display. */
export const CONFIRM_PREVIEW_NO_ROOM =
  "(preview does not fit: enlarge the terminal to review)";

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
      if (previewHidden() && (action === "yes" || action === "continue")) return;
      if (action === "yes" || action === "continue") props.overlay.resolveConfirm(true);
      else if (action === "no" || action === "stop") props.overlay.resolveConfirm(false);
    });
    onCleanup(off);
  });

  const prompt = () => props.overlay.confirmPrompt();
  const question = () => formatConfirmQuestion(prompt()?.message ?? "", prompt()?.mode ?? "step");
  const preview = () => prompt()?.preview ?? [];
  const hasPreview = () => preview().length > 0;
  const questionLines = () => question().split("\n").length;
  const previewRows = () => confirmPreviewRows(dimensions().height, questionLines(), hasPreview());
  // A prompt that carries a preview must not be approved blind. When the frame
  // cannot fit the three rows below, say so instead of showing nothing.
  const previewHidden = () => hasPreview() && previewRows() < CONFIRM_MIN_PREVIEW_ROWS;
  const innerWidth = () => overlayFrameInnerWidth(dimensions().width, CONFIRM_FRAME_WIDTH);
  const previewLines = () =>
    previewHidden() ? [] : visiblePreviewRows(preview(), previewRows(), innerWidth());
  const maxHeight = () => confirmFrameMaxHeight(dimensions().height, hasPreview());

  return (
    <OverlayFrame width={CONFIRM_FRAME_WIDTH} maxHeight={maxHeight()}>
      <Show when={previewHidden()}>
        <text>
          <span style={TUI_STYLE.warning}>{CONFIRM_PREVIEW_NO_ROOM}</span>
        </text>
      </Show>
      <text>{question()}</text>
      <For each={previewLines()}>
        {(line) => (
          <text>
            <span style={TUI_STYLE.muted}>{line.length === 0 ? " " : line}</span>
          </text>
        )}
      </For>
      <text><span style={TUI_STYLE.muted}>{previewHidden() ? "enlarge the terminal to approve · n / Enter / Esc decline" : confirmHint(prompt()?.mode ?? "step")}</span></text>
    </OverlayFrame>
  );
}
