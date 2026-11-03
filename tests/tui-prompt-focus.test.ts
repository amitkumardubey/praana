/**
 * Prompt focus guard: a mouse click / drag-select in the transcript must not
 * leave typing dead. The pure decision helper is exercised here; the real
 * flow is covered by the tmux smoke.
 */
import { describe, expect, it } from "bun:test";
import { shouldRestorePromptFocus } from "../src/ui/tui/transcript/view.js";

describe("shouldRestorePromptFocus", () => {
  it("restores the prompt after a transcript click left nothing focused", () => {
    expect(
      shouldRestorePromptFocus({
        overlayOpen: false,
        transcriptFocusMode: false,
        editorFocused: false,
      }),
    ).toBe(true);
  });

  it("leaves a focused text editor (prompt or overlay input) alone", () => {
    expect(
      shouldRestorePromptFocus({
        overlayOpen: false,
        transcriptFocusMode: false,
        editorFocused: true,
      }),
    ).toBe(false);
  });

  it("never steals focus from an open overlay", () => {
    for (const editorFocused of [true, false]) {
      expect(
        shouldRestorePromptFocus({
          overlayOpen: true,
          transcriptFocusMode: false,
          editorFocused,
        }),
      ).toBe(false);
    }
  });

  it("never steals focus in transcript (F9) focus mode", () => {
    for (const editorFocused of [true, false]) {
      expect(
        shouldRestorePromptFocus({
          overlayOpen: false,
          transcriptFocusMode: true,
          editorFocused,
        }),
      ).toBe(false);
    }
  });
});
