/**
 * Solid toast host — ephemeral messages above the prompt.
 */
import { For, type Accessor } from "solid-js";
import { TUI_STYLE, type SpanStyle } from "./theme.js";
import type { UiToast, ToastTone } from "./shell-ui.js";

const TONE_GLYPH: Record<ToastTone, string> = {
  info: "ℹ",
  success: "✓",
  warn: "▲",
  error: "✕",
};

function toneStyle(tone: ToastTone): SpanStyle {
  if (tone === "error") return TUI_STYLE.error;
  if (tone === "warn") return TUI_STYLE.warning;
  if (tone === "success") return TUI_STYLE.success;
  return TUI_STYLE.info;
}

export function ToastHost(props: { toasts: Accessor<UiToast[]> }) {
  return (
    <box id="toast-region" flexDirection="column" flexShrink={0}>
      <For each={props.toasts()}>
        {(t) => (
          <text>
            <span style={toneStyle(t.tone)}>{`  ${TONE_GLYPH[t.tone]} ${t.message}`}</span>
          </text>
        )}
      </For>
    </box>
  );
}
