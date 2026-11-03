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
import type { Accessor } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { TUI_PALETTE, TUI_STYLE } from "./theme.js";
import { launchHintForWidth } from "./boot-summary.js";

/**
 * First-screen hint for the current terminal width. Unknown widths (0, NaN
 * — e.g. before the terminal reports dimensions) fall back to the
 * 80-column short form so the hint always renders.
 */
export function launchHintForTerminalWidth(width: number): string {
  return launchHintForWidth(width > 0 ? width : 80);
}

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
      <text>
        <span style={TUI_STYLE.faint}>
          {launchHintForTerminalWidth(dimensions().width)}
        </span>
      </text>
    </box>
  );
}
