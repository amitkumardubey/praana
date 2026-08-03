import { describe, it, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { buildTranscriptIndex } from "../src/ui/tui/transcript/index.js";
import { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import { generateLargeTranscriptEvents } from "./fixtures/large-transcript.js";

describe("TranscriptContainer with a large resumed session", () => {
  it("loads all groups and reports correct total", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const events = generateLargeTranscriptEvents({ turns: 250 });
      const index = buildTranscriptIndex(events, { useUnicode: true });
      const container = new TranscriptContainer(setup.renderer, {
        markdownRendering: false,
        syntaxTheme: "nord",
        backgroundZones: false,
        useUnicode: true,
      });
      setup.renderer.root.add(container);
      container.loadIndex(index);
      await setup.renderOnce();

      expect(container.getTotalGroups()).toBe(250);
      expect(container.children.length).toBeGreaterThan(0);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("scrolls up and down via ScrollBoxRenderable", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const events = generateLargeTranscriptEvents({ turns: 50 });
      const index = buildTranscriptIndex(events, { useUnicode: true });
      const container = new TranscriptContainer(setup.renderer, {
        markdownRendering: false,
        syntaxTheme: "nord",
        backgroundZones: false,
        useUnicode: true,
      });
      setup.renderer.root.add(container);
      container.loadIndex(index);
      await setup.renderOnce();

      const initialScrollTop = container.scrollTop;
      container.onScrollUp();
      await setup.renderOnce();
      expect(container.scrollTop).toBeLessThanOrEqual(initialScrollTop);

      container.onScrollDown();
      await setup.renderOnce();
      expect(container.scrollTop).toBeGreaterThanOrEqual(initialScrollTop);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("resolves a large tool body lazily in focus mode", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const events = generateLargeTranscriptEvents({ turns: 10, toolChars: 10_000 });
      const index = buildTranscriptIndex(events, { useUnicode: true });
      const container = new TranscriptContainer(setup.renderer, {
        markdownRendering: false,
        syntaxTheme: "nord",
        backgroundZones: false,
        useUnicode: true,
      });
      setup.renderer.root.add(container);
      container.loadIndex(index);
      container.setFocused(true);
      await setup.renderOnce();

      container.handleInput("\x1b[A");
      container.handleInput("\r");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(container.isRowExpanded("tool-10")).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });
});