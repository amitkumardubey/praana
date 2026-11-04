/**
 * runTui is a Solid + OpenTUI entry (`src/ui/tui/run.tsx`).
 * Full integration coverage lives in interminai smokes and unit tests for
 * shell-ui / overlay-state / transcript-store / prompt-helpers.
 *
 * Prefer those focused suites over a heavy FakeCliRenderer mock.module harness.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { createOverlayUi } from "../src/ui/tui/overlays/state.js";
import { createShellUi } from "../src/ui/tui/shell-ui.js";
import { createTranscriptStore } from "../src/ui/tui/transcript/store.js";
import { segmentsToPlainText } from "../src/ui/tui/theme.js";
import { focusPromptAfterConfirm, shouldShowAgentsTruncationToast } from "../src/ui/tui/run.tsx";

describe("AGENTS truncation toast on /new", () => {
  it("surfaces the notice for a fresh startup info when not yet shown", () => {
    expect(
      shouldShowAgentsTruncationToast({ agentTruncationNotices: ["n"] }, false),
    ).toBe(true);
    expect(
      shouldShowAgentsTruncationToast({ agentTruncationNotices: [] }, false),
    ).toBe(false);
  });

  it("honors the once-per-process rule", () => {
    expect(
      shouldShowAgentsTruncationToast({ agentTruncationNotices: ["n"] }, true),
    ).toBe(false);
  });
});

describe("step-pause confirm focus", () => {
  it("returns focus to the prompt only when no overlay is left open", () => {
    let focuses = 0;
    const focus = () => {
      focuses += 1;
    };
    focusPromptAfterConfirm("none", focus);
    expect(focuses).toBe(1);
    focusPromptAfterConfirm("model", focus);
    focusPromptAfterConfirm("palette", focus);
    focusPromptAfterConfirm("confirm", focus);
    expect(focuses).toBe(1);
  });

  it("does not focus the prompt when dismiss promotes a queued confirm", () => {
    const overlay = createOverlayUi();
    const pending = overlay.showConfirm("continue?");
    overlay.showModel();
    let focuses = 0;
    overlay.dismiss();
    focusPromptAfterConfirm(overlay.kind(), () => {
      focuses += 1;
    });
    expect(overlay.kind()).toBe("model");
    expect(focuses).toBe(0);
    overlay.resolveConfirm(false);
    void pending;
    overlay.dispose();
  });

  it("refocuses from dismissOverlay only when that dismiss leaves nothing open", () => {
    const src = readFileSync(new URL("../src/ui/tui/run.tsx", import.meta.url), "utf8");
    const dismiss = src.slice(
      src.indexOf("const dismissOverlay = () => {"),
      src.indexOf("const handleSlashTrigger"),
    );
    expect(dismiss).toContain("focusPromptAfterConfirm(overlay.kind(), focusPrompt)");
    expect(dismiss).not.toContain("focusPrompt();");
    const ctrlC = src.slice(
      src.indexOf("if (ctrlC.action === \"cancel_overlay\")"),
      src.indexOf("if (!session)"),
    );
    expect(ctrlC).not.toContain("focusPrompt();");
    const setup = src.slice(
      src.indexOf("const handleSetupComplete"),
      src.indexOf("const handleConsentComplete"),
    );
    expect(setup).not.toContain("focusPrompt();");
  });
});

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

  it("keeps error/warn as ephemeral toasts and does not auto-open the console", () => {
    const ui = createShellUi();
    let shown = 0;
    ui.toast.attachConsole({
      show() {
        shown += 1;
      },
    });
    ui.toast.show("billing denied", "error");
    ui.toast.show("pressure rising", "warn");
    ui.toast.show("model switched", "success");
    expect(shown).toBe(0);
    expect(ui.toasts().some((t) => t.message === "billing denied")).toBe(true);
    expect(ui.toasts().some((t) => t.message === "pressure rising")).toBe(true);
    expect(ui.toasts().some((t) => t.message === "model switched")).toBe(true);
    ui.dispose();
  });
});
