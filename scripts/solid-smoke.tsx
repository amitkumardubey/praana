/**
 * Minimal @opentui/solid smoke entry — used to verify toolchain wiring.
 * Not part of the production CLI path.
 */
import { render } from "@opentui/solid";

function App() {
  return (
    <box border padding={1}>
      <text>praana solid ok</text>
    </box>
  );
}

await render(() => <App />, { exitOnCtrlC: true, targetFps: 30 });
