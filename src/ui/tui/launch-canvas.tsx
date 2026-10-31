/**
 * Idle launch canvas — ASCIIFont wordmark + version + skills, plus a dim
 * first-screen hint while the transcript is empty.
 * Spec: launch-screen design lock (internal)
 *
 * The coral-breath pulse was removed: the canvas only renders while the app
 * is idle (no transcript entries), so a perpetual animated dash read as an
 * unexplained loading indicator. Real loading is already shown by the
 * spinner host.
 */
import { Show, type Accessor } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { TUI_PALETTE, TUI_STYLE } from "./theme.js";
import { launchHintForWidth } from "./boot-summary.js";

export function LaunchCanvas(props: {
  version: Accessor<string>;
  skillsLabel: Accessor<string>;
}) {
  // The canvas only mounts inside the real TUI (App/run.tsx), so there is
  // no headless path to guard here; the width-aware hint keeps the line
  // from wrapping on narrow terminals.
  const dimensions = useTerminalDimensions();
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
        <span style={TUI_STYLE.chromeMuted}>{props.skillsLabel()}</span>
      </text>
      <Show when={dimensions().width > 0}>
        <text>
          <span style={TUI_STYLE.faint}>
            {launchHintForWidth(dimensions().width || 80)}
          </span>
        </text>
      </Show>
    </box>
  );
}
