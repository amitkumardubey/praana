import { describe, it, expect } from "bun:test";
import {
  formatSessionEndEpilogue,
  RESUME_ID_PREFIX_LEN,
  type SessionEndEpilogueInput,
} from "../src/app-banner.js";

function base(overrides: Partial<SessionEndEpilogueInput> = {}): SessionEndEpilogueInput {
  return {
    sessionId: "01KXBQF4FBQ7KDPDB9SX9XMFYP",
    memory: "completed",
    turns: 3,
    stateObjects: 2,
    rememberCalls: 0,
    recallUsed: 0,
    learningsStored: 0,
    ...overrides,
  };
}

describe("formatSessionEndEpilogue", () => {
  it("does not claim consolidation or print a duplicate Session ended line", () => {
    const lines = formatSessionEndEpilogue(base());
    const text = lines.join("\n");
    expect(text.toLowerCase()).not.toContain("consolidation");
    expect(text).not.toContain("Session ended:");
    expect(text).not.toContain("what this session taught");
  });

  it("prints a unique-enough resume id (12 chars)", () => {
    const lines = formatSessionEndEpilogue(base());
    const resume = lines.find((l) => l.includes("resume"));
    expect(resume).toBeDefined();
    expect(resume).toContain(`praana resume ${"01KXBQF4FBQ7KDPDB9SX9XMFYP".slice(0, RESUME_ID_PREFIX_LEN)}`);
    expect(RESUME_ID_PREFIX_LEN).toBe(12);
  });

  it("omits zero outcome counts and shows memory saved when completed", () => {
    const text = formatSessionEndEpilogue(base()).join("\n");
    expect(text).toContain("session saved · 3 turns · 2 state objects");
    expect(text).toContain("memory saved");
    expect(text).not.toContain("remembered");
    expect(text).not.toContain("reinforced");
    expect(text).not.toContain("learned");
  });

  it("includes remembered / reinforced / learned only when > 0", () => {
    const text = formatSessionEndEpilogue(
      base({ rememberCalls: 1, recallUsed: 2, learningsStored: 4 }),
    ).join("\n");
    expect(text).toContain("memory saved · remembered 1 · reinforced 2 · learned 4");
  });

  it("says saving in background and omits learnings when memory is background", () => {
    const text = formatSessionEndEpilogue(
      base({ memory: "background", learningsStored: 9, recallUsed: 1 }),
    ).join("\n");
    expect(text).toContain("saving in background");
    expect(text).not.toContain("learned");
    expect(text).toContain("reinforced 1");
  });

  it("says memory off for skipped/noop and memory failed for failed", () => {
    expect(formatSessionEndEpilogue(base({ memory: "skipped" })).join("\n")).toContain(
      "memory off",
    );
    expect(formatSessionEndEpilogue(base({ memory: "noop" })).join("\n")).toContain(
      "memory off",
    );
    expect(formatSessionEndEpilogue(base({ memory: "failed" })).join("\n")).toContain(
      "memory failed",
    );
  });

  it("handles zero turns without claiming taught content", () => {
    const text = formatSessionEndEpilogue(base({ turns: 0, stateObjects: 1 })).join("\n");
    expect(text).toContain("session saved · 0 turns · 1 state object");
    expect(text.toLowerCase()).not.toContain("taught");
  });
});
