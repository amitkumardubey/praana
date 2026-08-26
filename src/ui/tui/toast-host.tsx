/**
 * Solid toast host — ephemeral messages above the prompt.
 * LLM failures belong in the transcript; this strip is for short slash/UI feedback.
 */
import { For, type Accessor } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { TUI_STYLE, type SpanStyle, truncatePlainText } from "./theme.js";
import type { UiToast, ToastTone } from "./shell-ui.js";

const TONE_GLYPH: Record<ToastTone, string> = {
  info: "ℹ",
  success: "✓",
  warn: "▲",
  error: "✕",
};

/** Reserve room for the leading glyph + indentation so the message itself fits. */
const TOAST_PAD = 4;
/** Cap the number of toasts painted so a burst cannot overflow the chrome. */
const MAX_TOASTS = 4;

function toneStyle(tone: ToastTone): SpanStyle {
  if (tone === "error") return TUI_STYLE.error;
  if (tone === "warn") return TUI_STYLE.warning;
  if (tone === "success") return TUI_STYLE.success;
  return TUI_STYLE.info;
}

export function ToastHost(props: { toasts: Accessor<UiToast[]> }) {
  const dimensions = useTerminalDimensions();
  const shown = () => props.toasts().slice(-MAX_TOASTS);

  return (
    <box id="toast-region" flexDirection="column" flexShrink={0}>
      <For each={shown()}>
        {(t) => {
          const width = dimensions().width || 80;
          const maxMsg = Math.max(8, width - TOAST_PAD);
          const message = truncatePlainText(t.message, maxMsg);
          return (
            <text>
              <span style={toneStyle(t.tone)}>{`  ${TONE_GLYPH[t.tone]} ${message}`}</span>
            </text>
          );
        }}
      </For>
    </box>
  );
}
