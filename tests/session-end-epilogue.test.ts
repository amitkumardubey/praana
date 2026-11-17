import { describe, it, expect } from "bun:test";
import {
  formatSessionEndEpilogue,
  RESUME_ID_PREFIX_LEN,
  type SessionEndEpilogueInput,
} from "../src/app-banner.js";

function base(overrides: Partial<SessionEndEpilogueInput> = {}): SessionEndEpilogueInput {
  return {
    sessionId: "01KXBQF4FBQ7KDPDB9SX9XMFYP",
    memory: "noop",
    turns: 3,
    stateObjects: 2,
    rememberCalls: 0,
    recallUsed: 0,
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

  it("omits zero outcome counts", () => {
    const text = formatSessionEndEpilogue(base()).join("\n");
    expect(text).toContain("session saved · 3 turns · 2 state objects");
    expect(text).toContain("file memory");
    expect(text).not.toContain("remembered");
    expect(text).not.toContain("recalled");
    expect(text).not.toContain("learned");
  });

  it("includes deliberate writes and recalls", () => {
    const text = formatSessionEndEpilogue(base({ rememberCalls: 1, recallUsed: 2 })).join("\n");
    expect(text).toContain("file memory · remembered 1 · recalled 2");
  });

  it("distinguishes file memory from memory off", () => {
    expect(formatSessionEndEpilogue(base({ memory: "skipped" })).join("\n")).toContain("memory off");
    expect(formatSessionEndEpilogue(base({ memory: "noop" })).join("\n")).toContain("file memory");
  });

  it("handles zero turns without claiming taught content", () => {
    const text = formatSessionEndEpilogue(base({ turns: 0, stateObjects: 1 })).join("\n");
    expect(text).toContain("session saved · 0 turns · 1 state object");
    expect(text.toLowerCase()).not.toContain("taught");
  });
});
