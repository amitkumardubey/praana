import { describe, it, expect } from "bun:test";
import {
  createAppendBackendState,
  createAppendBackend,
} from "../../src/terminal/backend/append.js";

describe("append backend", () => {
  it("should append lines to scrollback", () => {
    const state = createAppendBackendState(40, 2);
    const writes: string[] = [];
    const backend = createAppendBackend(state, { write: (s) => writes.push(s) });

    backend.appendLines(["Hello", "World"]);

    expect(state.scrollback).toEqual(["Hello", "World"]);
    expect(writes.join("")).toContain("Hello");
    expect(writes.join("")).toContain("World");
  });

  it("should rewrite live lines", () => {
    const state = createAppendBackendState(40, 2);
    const writes: string[] = [];
    const backend = createAppendBackend(state, { write: (s) => writes.push(s) });

    backend.setLiveLines(["streaming..."]);
    expect(state.liveLines).toEqual(["streaming..."]);
    expect(writes.length).toBeGreaterThan(0);
  });
});

describe("append backend live region (preserve mode)", () => {
  it("never moves the cursor up into committed scrollback on first paint", () => {
    const state = createAppendBackendState(40, 2);
    const writes: string[] = [];
    const backend = createAppendBackend(state, { write: (s) => writes.push(s) });

    backend.appendLines(["You", "hello"]); // committed
    backend.setLiveLines(["streaming line 1"]); // first live paint

    const liveSeq = writes.at(-1)!;
    // No cursor-up: renderedLiveCount started at 0, so the region is painted
    // in place rather than reaching up into the committed "You"/"hello" rows.
    expect(liveSeq).not.toMatch(/\x1b\[\d+A/);
    expect(state.renderedLiveCount).toBe(1);
  });

  it("gives each live line its own row (no single-row collapse)", () => {
    const state = createAppendBackendState(40, 2);
    const writes: string[] = [];
    const backend = createAppendBackend(state, { write: (s) => writes.push(s) });

    backend.setLiveLines(["one", "two", "three"]);

    const seq = writes.join("");
    expect(seq).toContain("one\r\n");
    expect(seq).toContain("two\r\n");
    expect(seq).toContain("three\r\n");
    expect(state.renderedLiveCount).toBe(3);
  });

  it("rewrites in place by moving up exactly the rendered height", () => {
    const state = createAppendBackendState(40, 2);
    const writes: string[] = [];
    const backend = createAppendBackend(state, { write: (s) => writes.push(s) });

    backend.setLiveLines(["a", "b"]); // renders 2 rows
    writes.length = 0;
    backend.setLiveLines(["a", "b", "c"]); // repaint

    const seq = writes.join("");
    // Moves up exactly 2 (the previously rendered height) — not 2 + pinnedRows,
    // which would climb into committed scrollback every delta.
    expect(seq).toContain("\x1b[2A");
    expect(seq).not.toContain("\x1b[4A");
    expect(seq).toContain("\x1b[0J"); // clear region + below before repaint
    expect(state.renderedLiveCount).toBe(3);
  });

  it("erases the rendered region on clearLive so completed text is not duplicated", () => {
    const state = createAppendBackendState(40, 2);
    const writes: string[] = [];
    const backend = createAppendBackend(state, { write: (s) => writes.push(s) });

    backend.setLiveLines(["partial answer"]);
    writes.length = 0;
    backend.clearLive();

    const seq = writes.join("");
    expect(seq).toContain("\x1b[1A"); // up over the one rendered row
    expect(seq).toContain("\x1b[0J"); // erase it
    expect(state.renderedLiveCount).toBe(0);
    expect(state.liveLines).toEqual([]);
  });

  it("lifts an active live region before appending committed lines", () => {
    const state = createAppendBackendState(40, 2);
    const writes: string[] = [];
    const backend = createAppendBackend(state, { write: (s) => writes.push(s) });

    backend.setLiveLines(["streaming"]);
    writes.length = 0;
    backend.appendLines(["final committed line"]);

    const seq = writes.join("");
    expect(seq).toContain("\x1b[1A\x1b[0G\x1b[0J"); // erase region first
    expect(seq).toContain("final committed line");
    expect(state.renderedLiveCount).toBe(0);
  });
});
