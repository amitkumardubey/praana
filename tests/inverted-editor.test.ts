/**
 * Regression tests for the pi-tui input wrapper.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Editor, visibleWidth } from "@earendil-works/pi-tui";
import { InvertedEditor } from "../src/ui/tui/inverted-editor.js";

const editorTheme = {
  borderColor: () => "",
  selectList: {
    selectedPrefix: (s: string) => s,
    selectedText: (s: string) => s,
    description: (s: string) => s,
    scrollInfo: (s: string) => s,
    noMatch: (s: string) => s,
  },
};

function makeFakeTUI() {
  return {
    terminal: { rows: 40 },
    requestRender: () => {},
  } as unknown as Parameters<typeof Editor>[0];
}

describe("InvertedEditor", () => {
  let editor: InvertedEditor;

  beforeEach(() => {
    const tui = makeFakeTUI();
    editor = new InvertedEditor(tui, editorTheme, { paddingY: 0 });
    editor.focused = true;
  });

  it("keeps every rendered line within the requested width", () => {
    const width = 125;
    editor.inner.setText(
      "now lets pick a github issue to work on next plan to work on it on its own branch and then execute the plan then review",
    );
    editor.inner.focused = true;

    const lines = editor.render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("does not overflow when the cursor sits at the end of a full line", () => {
    const width = 50;
    // With prompt width 2, content width is width - 4, so 46 chars fits on
    // one layout line. Put the cursor at the end and assert the prompt line
    // is still exactly the requested width.
    editor.inner.setText("a".repeat(width - 4));
    editor.inner.focused = true;

    const lines = editor.render(width);
    const promptLine = lines.find((line) => line.startsWith("❯"));
    expect(promptLine).toBeDefined();
    expect(visibleWidth(promptLine!)).toBe(width);
  });

  it("prefixes the first content line with the prompt and later lines with indent", () => {
    const width = 40;
    // Force wrapping across multiple layout lines.
    editor.inner.setText("word ".repeat(20).trim());
    editor.inner.focused = false;

    const lines = editor.render(width);
    const contentLines = lines.filter((line) => line.startsWith("❯") || line.startsWith("  "));
    expect(contentLines.length).toBeGreaterThan(1);
    expect(contentLines[0].startsWith("❯ ")).toBe(true);
    for (const continuation of contentLines.slice(1)) {
      expect(continuation.startsWith("  ")).toBe(true);
    }
  });
});
