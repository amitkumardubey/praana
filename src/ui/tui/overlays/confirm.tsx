/**
 * Minimal confirm overlay for the per-turn step pause.
 * Enter continues. Esc stops and asks for a summary. Both are ignored
 * until `CONFIRM_ARM_MS` has passed, so a key that closed the previous
 * overlay cannot answer this one. Ctrl+C is never part of that window
 * and is not consumed: the global handler aborts the turn.
 *
 * Other keys are swallowed while the overlay is open. A new confirm
 * prompt id arms Enter and Esc again.
 */
import { createEffect, onCleanup } from "solid-js";
import { useKeymap } from "@opentui/keymap/solid";
import { OverlayFrame } from "./frame.js";
import { TUI_STYLE } from "../theme.js";
import type { OverlayUi } from "./state.js";

/** How long a freshly opened step-pause confirm ignores Enter and Esc. */
export const CONFIRM_ARM_MS = 100;

export const CONFIRM_HINT = "Enter = continue · Esc = stop and summarise · Ctrl+C = abort";

export interface ConfirmOverlayProps {
  overlay: OverlayUi;
  /** Override the arm delay in tests. Defaults to `CONFIRM_ARM_MS`. */
  armMs?: number;
}

export type StepPauseKeyAction = "continue" | "stop" | "ignore" | "passthrough";

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

export function ConfirmOverlay(props: ConfirmOverlayProps) {
  const keymap = useKeymap();

  // Re-bind when the prompt identity changes so Enter and Esc arm again.
  createEffect(() => {
    const prompt = props.overlay.confirmPrompt();
    if (!prompt) return;
    // Prompt identity: a new id (or a replaced prompt object) arms Enter again.
    void prompt.id;
    const armedAt = Date.now() + (props.armMs ?? CONFIRM_ARM_MS);
    const off = keymap.intercept("key", (ctx) => {
      const e = ctx.event;
      const action = classifyStepPauseKey(e.name, !!e.ctrl, Date.now() >= armedAt);
      if (action === "passthrough") return;
      ctx.consume({ preventDefault: true, stopPropagation: true });
      if (action === "stop") props.overlay.resolveConfirm(false);
      else if (action === "continue") props.overlay.resolveConfirm(true);
    });
    onCleanup(off);
  });

  return (
    <OverlayFrame width={64}>
      <text>{props.overlay.confirmPrompt()?.message ?? ""}</text>
      <text><span style={TUI_STYLE.muted}>{CONFIRM_HINT}</span></text>
    </OverlayFrame>
  );
}
