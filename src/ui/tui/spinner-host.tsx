/**
 * Solid animated spinner row (replaces imperative Spinner BoxRenderable).
 */
import { createSignal, onCleanup, Show, type Accessor } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { TUI_STYLE } from "./theme.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function SpinnerHost(props: {
  active: Accessor<boolean>;
  message: Accessor<string>;
}) {
  const renderer = useRenderer();
  const [frame, setFrame] = createSignal(0);

  const timer = setInterval(() => {
    if (!props.active()) return;
    setFrame((f) => (f + 1) % FRAMES.length);
    renderer.requestRender();
  }, 80);
  onCleanup(() => clearInterval(timer));

  return (
    <Show when={props.active()}>
      <box id="spinner" flexDirection="row" flexShrink={0}>
        <text>
          <span style={TUI_STYLE.muted}>{`${FRAMES[frame()]} ${props.message()}`}</span>
        </text>
      </box>
    </Show>
  );
}
