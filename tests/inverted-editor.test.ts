/**
 * Regression tests for the OpenTUI inverted editor.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { InvertedEditor } from "../src/ui/tui/inverted-editor.js";

describe("InvertedEditor", () => {
  let editor: InvertedEditor;

  beforeEach(async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    editor = new InvertedEditor(setup.renderer, { paddingY: 0 });
    setup.renderer.root.add(editor);
    await setup.renderOnce();
  });

  it("renders the prompt prefix", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      ed.setText("hello");
      setup.renderer.root.add(ed);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("❯");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders the textarea content after the prompt", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      ed.setText("hello world");
      setup.renderer.root.add(ed);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("hello world");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("focuses the textarea when focused is set to true", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      ed.focused = true;
      setup.renderer.root.add(ed);
      await setup.renderOnce();
      expect(ed.focused).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("focus() delegates to the inner textarea (BoxRenderable focus is a no-op)", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      setup.renderer.root.add(ed);
      ed.focus();
      await setup.renderOnce();
      expect(ed.focused).toBe(true);
      expect(ed.inner.focused).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("blurs the textarea when focused is set to false", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      ed.focused = true;
      expect(ed.focused).toBe(true);
      ed.focused = false;
      expect(ed.focused).toBe(false);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("setText and getText round-trip correctly", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      ed.setText("test content");
      expect(ed.getText()).toBe("test content");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("keeps the prompt outside the editable buffer", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      ed.setText("hello");
      expect(ed.getText()).toBe("hello");
      expect(ed.inner.plainText).toBe("hello");
      expect(ed.inner.plainText).not.toContain("❯");
      setup.renderer.root.add(ed);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("❯");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("onSubmit is called when the textarea submits", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      let submittedText = "";
      ed.onSubmit = (text: string) => {
        submittedText = text;
      };
      ed.setText("hello");
      ed.inner.submit();
      expect(submittedText).toBe("hello");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("submits on Enter (not newline)", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      setup.renderer.root.add(ed);
      ed.focus();
      let submittedText = "";
      ed.onSubmit = (text: string) => {
        submittedText = text;
      };
      ed.setText("enter-submits");
      await setup.mockInput.pressEnter();
      expect(submittedText).toBe("enter-submits");
      expect(ed.getText()).toBe("enter-submits");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders within the requested width", async () => {
    const setup = await createTestRenderer({ width: 40, height: 20 });
    try {
      const ed = new InvertedEditor(setup.renderer, { paddingY: 0 });
      ed.setText("a".repeat(30));
      setup.renderer.root.add(ed);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      for (const line of frame.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(40);
      }
    } finally {
      setup.renderer.destroy();
    }
  });
});