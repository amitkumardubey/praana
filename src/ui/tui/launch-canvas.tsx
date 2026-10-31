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
import { TUI_PALETTE, TUI_STYLE } from "./theme.js";
import { LAUNCH_HINT_TEXT } from "./boot-summary.js";

export function LaunchCanvas(props: {
  version: Accessor<string>;
  skillsLabel: Accessor<string>;
}) {
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
      <Show when={process.stdout.isTTY}>
        <text>
          <span style={TUI_STYLE.faint}>{LAUNCH_HINT_TEXT}</span>
        </text>
      </Show>
    </box>
  );
}
