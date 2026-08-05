/**
 * runTui is a Solid + OpenTUI entry (`src/ui/tui/run.tsx`).
 * Full integration coverage lives in interminai smokes and unit tests for
 * shell-ui / overlay-state / transcript-store / prompt-helpers.
 *
 * Prefer those focused suites over a heavy FakeCliRenderer mock.module harness.
 */
import { describe, expect, it } from "bun:test";
import { createOverlayUi } from "../src/ui/tui/overlays/state.js";
import { createShellUi } from "../src/ui/tui/shell-ui.js";
import { createTranscriptStore } from "../src/ui/tui/transcript/store.js";
import { segmentsToPlainText } from "../src/ui/tui/theme.js";

describe("runTui Solid shell primitives", () => {
  it("creates disposable shell, overlay, and transcript stores", () => {
    const ui = createShellUi();
    const overlay = createOverlayUi();
    const transcript = createTranscriptStore();
    expect(segmentsToPlainText(ui.chrome.identitySegments())).toContain("praana");
    expect(ui.launch.version()).toBe("v0.0.0");
    expect(ui.launch.skillsLabel()).toContain("skills discovered");
    expect(overlay.kind()).toBe("none");
    expect(transcript.entries.length).toBe(0);
    transcript.dispose();
    overlay.dispose();
    ui.dispose();
  });
});
