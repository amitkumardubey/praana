/**
 * Minimal confirm overlay for the per-turn step pause.
 * Enter continues. Esc stops and asks for a summary. Ctrl+C is not
 * consumed, including during the arm window, so the global handler aborts
 * the turn without a wrap-up request.
 *
 * Other keys are swallowed. Enter is ignored until `CONFIRM_ARM_MS` has
 * passed so an Enter already in flight does not auto-continue. A new
 * confirm prompt id arms Enter again (this component stays mounted across
 * prompts when the host does not remount it).
 */
import { createEffect, onCleanup } from "solid-js";
import { useKeymap } from "@opentui/keymap/solid";
import { OverlayFrame } from "./frame.js";
import { TUI_STYLE } from "../theme.js";
import type { OverlayUi } from "./state.js";

/** How long a freshly opened step-pause confirm ignores Enter. */
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
  if (name === "escape" || name === "esc") return "stop";
  if (!armed) return "ignore";
  if (name === "enter" || name === "return") return "continue";
  return "ignore";
}

export function ConfirmOverlay(props: ConfirmOverlayProps) {
  const keymap = useKeymap();

  // Re-bind when the prompt identity changes. A later confirm keeps `kind`
  // at "confirm", so this component does not unmount and onMount would not
  // arm Enter again.
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
