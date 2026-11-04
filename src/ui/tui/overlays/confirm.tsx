/**
 * Minimal confirm overlay for the per-turn step pause: Enter continues,
 * Esc / Ctrl+C stops (wrap-up). Every other key is swallowed while it is
 * open so a user interrupt is never dropped or double-handled.
 *
 * Keys are swallowed immediately. Enter is ignored until `CONFIRM_ARM_MS`
 * has passed so an Enter already in flight does not auto-continue. Esc and
 * Ctrl+C stop at any time, including during that window. A new confirm
 * prompt id arms Enter again (the component stays mounted across prompts).
 */
import { createEffect, onCleanup } from "solid-js";
import { useKeymap } from "@opentui/keymap/solid";
import { OverlayFrame } from "./frame.js";
import { TUI_STYLE } from "../theme.js";
import type { OverlayUi } from "./state.js";

/** How long a freshly opened step-pause confirm ignores Enter. */
export const CONFIRM_ARM_MS = 100;

export interface ConfirmOverlayProps {
  overlay: OverlayUi;
  /** Override the arm delay in tests. Defaults to `CONFIRM_ARM_MS`. */
  armMs?: number;
}

function isStopKey(name: string, ctrl: boolean): boolean {
  return name === "escape" || name === "esc" || (name === "c" && ctrl);
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
      ctx.consume({ preventDefault: true, stopPropagation: true });
      const e = ctx.event;
      if (isStopKey(e.name, !!e.ctrl)) {
        props.overlay.resolveConfirm(false);
        return;
      }
      if (Date.now() < armedAt) return;
      if (e.name === "enter" || e.name === "return") {
        props.overlay.resolveConfirm(true);
      }
    });
    onCleanup(off);
  });

  return (
    <OverlayFrame width={64}>
      <text>{props.overlay.confirmPrompt()?.message ?? ""}</text>
      <text><span style={TUI_STYLE.muted}>Enter = continue · Esc = stop</span></text>
    </OverlayFrame>
  );
}
