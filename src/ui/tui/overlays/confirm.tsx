/**
 * Minimal confirm overlay for the per-turn step pause: Enter continues,
 * Esc / Ctrl+C stops (wrap-up). Every other key is swallowed while it is
 * open so a user interrupt is never dropped or double-handled.
 */
import { createEffect, onCleanup } from "solid-js";
import { useKeymap } from "@opentui/keymap/solid";
import { OverlayFrame } from "./frame.js";
import { TUI_STYLE } from "../theme.js";
import type { OverlayUi } from "./state.js";

export interface ConfirmOverlayProps {
  overlay: OverlayUi;
}

export function ConfirmOverlay(props: ConfirmOverlayProps) {
  const keymap = useKeymap();

  createEffect(() => {
    const off = keymap.intercept("key", (ctx) => {
      ctx.consume({ preventDefault: true, stopPropagation: true });
      const e = ctx.event;
      if (e.name === "enter" || e.name === "return") {
        props.overlay.resolveConfirm(true);
        return;
      }
      if (e.name === "escape" || e.name === "esc" || (e.name === "c" && e.ctrl)) {
        props.overlay.resolveConfirm(false);
        return;
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
