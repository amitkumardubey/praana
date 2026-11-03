import { describe, it, expect } from "bun:test";
import {
  LAUNCH_HINT_TEXT,
  formatLaunchCanvasMeta,
  formatAgentsTruncationNotice,
} from "../src/ui/tui/boot-summary.js";

describe("launch canvas hint copy", () => {
  it("the first-screen hint mentions the key commands and the newline key", () => {
    expect(LAUNCH_HINT_TEXT).toContain("Type a message to start");
    expect(LAUNCH_HINT_TEXT).toContain("/help");
    expect(LAUNCH_HINT_TEXT).toContain("/model");
    expect(LAUNCH_HINT_TEXT).toContain("Ctrl+J");
  });

  it("the hint is a single dim line (no newlines)", () => {
    expect(LAUNCH_HINT_TEXT).not.toContain("\n");
    expect(LAUNCH_HINT_TEXT).not.toContain("\r");
  });

  it("version/skills meta still formats", () => {
    const meta = formatLaunchCanvasMeta({
      session: { skills: [{ id: "a" }, { id: "b" }] } as never,
      version: "0.16.0",
    });
    expect(meta.versionLabel).toBe("v0.16.0");
    expect(meta.skillsLabel).toBe("2 skills discovered");
  });

  it("the AGENTS truncation notice is friendly and mentions the 4000-token cap", () => {
    expect(formatAgentsTruncationNotice()).toBe(
      "Project instructions (AGENTS.md) are long; using the first ~4000 tokens.",
    );
  });
});
