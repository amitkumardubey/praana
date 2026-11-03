/**
 * Minimal confirm overlay for the per-turn step pause: Enter continues,
 * Esc / Ctrl+C stops (wrap-up). Every other key is swallowed while it is
 * open so a user interrupt is never dropped or double-handled.
 *
 * Keys are swallowed immediately, but Enter / Esc are ignored until
 * `CONFIRM_ARM_MS` has passed so an Enter already in flight does not
 * auto-continue. Same arm delay the slash overlay uses.
 */
import { onCleanup, onMount } from "solid-js";
import { useKeymap } from "@opentui/keymap/solid";
import { OverlayFrame } from "./frame.js";
import { TUI_STYLE } from "../theme.js";
import type { OverlayUi } from "./state.js";

/** How long a freshly opened step-pause confirm ignores Enter and Esc. */
export const CONFIRM_ARM_MS = 100;

export interface ConfirmOverlayProps {
  overlay: OverlayUi;
  /** Override the arm delay in tests. Defaults to `CONFIRM_ARM_MS`. */
  armMs?: number;
}

export function ConfirmOverlay(props: ConfirmOverlayProps) {
  const keymap = useKeymap();

  onMount(() => {
    const armedAt = Date.now() + (props.armMs ?? CONFIRM_ARM_MS);
    const off = keymap.intercept("key", (ctx) => {
      ctx.consume({ preventDefault: true, stopPropagation: true });
      if (Date.now() < armedAt) return;
      const e = ctx.event;
      if (e.name === "enter" || e.name === "return") {
        props.overlay.resolveConfirm(true);
        return;
      }
      if (e.name === "escape" || e.name === "esc" || (e.name === "c" && e.ctrl)) {
        props.overlay.resolveConfirm(false);
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
