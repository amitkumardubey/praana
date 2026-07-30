import { describe, it, expect } from "bun:test";
import { buildTranscriptIndex } from "../src/ui/tui/transcript/index.js";
import { TranscriptContainer } from "../src/ui/tui/transcript/container.js";
import { generateLargeTranscriptEvents } from "./fixtures/large-transcript.js";

function fakeTui() {
  return { requestRender: () => {} } as never;
}

describe("TranscriptContainer with a large resumed session", () => {
  it("mounts a bounded range and can reach the oldest group", () => {
    const events = generateLargeTranscriptEvents({ turns: 250 });
    const index = buildTranscriptIndex(events, { useUnicode: true });
    const container = new TranscriptContainer(fakeTui(), {
      markdownRendering: false,
      syntaxTheme: "nord",
      backgroundZones: false,
      useUnicode: true,
    });

    container.loadIndex(index);

    const mounted = container.getMountedGroupRange();
    const mountedGroups = mounted.end - mounted.start;
    // Budget = 2 visible + 2 * overscanGroups (default 5) = 12 groups max.
    expect(mountedGroups).toBeLessThanOrEqual(12);
    expect(container.getTotalGroups()).toBe(250);

    // Scroll to the top of history.
    for (let i = 0; i < 200; i++) container.onScrollUp();

    expect(container.getMountedGroupRange().start).toBe(0);
    expect(container.getTotalGroups()).toBe(250);
  });

  it("keeps the mounted entry count bounded while traversing history", () => {
    const events = generateLargeTranscriptEvents({ turns: 250 });
    const index = buildTranscriptIndex(events, { useUnicode: true });
    const container = new TranscriptContainer(fakeTui(), {
      markdownRendering: false,
      syntaxTheme: "nord",
      backgroundZones: false,
      useUnicode: true,
    });
    container.loadIndex(index);

    for (let i = 0; i < 100; i++) container.onScrollUp();
    const mounted = container.getMountedGroupRange();
    // Default budget is 2 + 2*overscan (5) = 12 groups, plus one page (20).
    expect(mounted.end - mounted.start).toBeLessThanOrEqual(32);

    for (let i = 0; i < 100; i++) container.onScrollDown();
    const mounted2 = container.getMountedGroupRange();
    expect(mounted2.end).toBe(250);
  });

  it("resolves a large tool body lazily in focus mode", async () => {
    const events = generateLargeTranscriptEvents({ turns: 10, toolChars: 10_000 });
    const index = buildTranscriptIndex(events, { useUnicode: true });
    const container = new TranscriptContainer(
      fakeTui(),
      {
        markdownRendering: false,
        syntaxTheme: "nord",
        backgroundZones: false,
        useUnicode: true,
      },
      undefined,
      {
        onExpand: (entry) =>
          Promise.resolve({
            ok: true,
            text: `expanded body for ${entry.id}`,
          }),
      },
    );
    container.loadIndex(index);
    container.setFocused(true);

    // The default selection is the tail entry, which is the assistant row.
    // Move up to the tool row.
    container.handleInput("\x1b[A"); // up
    container.handleInput("\r"); // expand

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(container.isRowExpanded("tool-10")).toBe(true);
  });
});
