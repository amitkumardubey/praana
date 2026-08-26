/**
 * Idle launch canvas — ASCIIFont wordmark + version + coral breath + skills.
 * Spec: design-proto/LAUNCH-LOCK.md
 */
import { createSignal, onCleanup, type Accessor } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { TUI_PALETTE, TUI_STYLE } from "./theme.js";

const PULSE_FRAMES = ["  -  ", " --- ", "-----", " --- ", "  -  "] as const;
const PULSE_MS = 480;

export function LaunchCanvas(props: {
  version: Accessor<string>;
  skillsLabel: Accessor<string>;
}) {
  const renderer = useRenderer();
  const [frame, setFrame] = createSignal(0);

  const timer = setInterval(() => {
    setFrame((f) => (f + 1) % PULSE_FRAMES.length);
    renderer.requestRender();
  }, PULSE_MS);
  onCleanup(() => clearInterval(timer));

  return (
    <box
      id="launch-canvas"
      flexGrow={1}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
      minHeight={1}
    >
      <ascii_font text="praana" font="tiny" color={TUI_PALETTE.brand} />
      <box height={1} flexShrink={0} />
      <text>
        <span style={TUI_STYLE.chromeMuted}>{props.version()}</span>
      </text>
      <text>
        <span style={TUI_STYLE.accent}>{PULSE_FRAMES[frame()]}</span>
      </text>
      <text>
        <span style={TUI_STYLE.chromeMuted}>{props.skillsLabel()}</span>
      </text>
    </box>
  );
}
