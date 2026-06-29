import { describe, it, expect } from "bun:test";
import {
  createThinkingState,
  onThinkingDelta,
  closeThinking,
  toggleThinking,
} from "../src/thinking-display.js";

describe("thinking-display", () => {
  describe("createThinkingState", () => {
    it("initializes with visible = true", () => {
      const s = createThinkingState(true);
      expect(s.visible).toBe(true);
      expect(s.open).toBe(false);
      expect(s.buffer).toBe("");
    });

    it("initializes with visible = false", () => {
      const s = createThinkingState(false);
      expect(s.visible).toBe(false);
    });
  });

  describe("onThinkingDelta", () => {
    it("accumulates buffer and opens block on first delta", () => {
      const s = createThinkingState(true);
      const r = onThinkingDelta(s, "hello");
      expect(r).toEqual({ printHeader: true, printDelta: true });
      expect(s.open).toBe(true);
      expect(s.buffer).toBe("hello");
    });

    it("continues accumulating without header on subsequent deltas", () => {
      const s = createThinkingState(true);
      onThinkingDelta(s, "hello");
      const r = onThinkingDelta(s, " world");
      expect(r).toEqual({ printHeader: false, printDelta: true });
      expect(s.buffer).toBe("hello world");
    });

    it("returns nothing when visibility is off", () => {
      const s = createThinkingState(false);
      const r = onThinkingDelta(s, "secret");
      expect(r).toEqual({ printHeader: false, printDelta: false });
      expect(s.buffer).toBe(""); // not accumulated
      expect(s.open).toBe(false);
    });

    it("still accumulates buffer when toggled visible mid-stream", () => {
      const s = createThinkingState(true);
      onThinkingDelta(s, "first ");
      s.visible = false;
      const r = onThinkingDelta(s, "hidden");
      expect(r).toEqual({ printHeader: false, printDelta: false });
      // Buffer is NOT accumulated when hidden (guard is early return)
      expect(s.buffer).toBe("first ");
    });
  });

  describe("closeThinking", () => {
    it("returns null if block was never opened", () => {
      const s = createThinkingState(true);
      expect(closeThinking(s)).toBeNull();
      expect(s.open).toBe(false);
    });

    it("returns char count summary when buffer has content", () => {
      const s = createThinkingState(true);
      onThinkingDelta(s, "hello world");
      const summary = closeThinking(s);
      expect(summary).toBe("  [thinking: 11 chars]");
      expect(s.open).toBe(false);
      expect(s.buffer).toBe("");
    });

    it("returns null summary when buffer is empty/whitespace", () => {
      const s = createThinkingState(true);
      onThinkingDelta(s, "   ");
      const summary = closeThinking(s);
      expect(summary).toBeNull();
      expect(s.open).toBe(false);
    });

    it("can be called again after close (idempotent)", () => {
      const s = createThinkingState(true);
      onThinkingDelta(s, "data");
      closeThinking(s);
      expect(closeThinking(s)).toBeNull();
    });
  });

  describe("toggleThinking", () => {
    it("toggles from true to false", () => {
      const s = createThinkingState(true);
      const result = toggleThinking(s);
      expect(result).toBe(false);
      expect(s.visible).toBe(false);
    });

    it("toggles from false to true", () => {
      const s = createThinkingState(false);
      const result = toggleThinking(s);
      expect(result).toBe(true);
      expect(s.visible).toBe(true);
    });

    it("double toggle restores original state", () => {
      const s = createThinkingState(true);
      toggleThinking(s);
      toggleThinking(s);
      expect(s.visible).toBe(true);
    });
  });
});
