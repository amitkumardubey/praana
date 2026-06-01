import { describe, it, expect } from "vitest";
import { detectActivityLogNote } from "../src/tools/memory.js";

describe("note quality lint", () => {
  it("warns on activity-log style notes", () => {
    const warning = detectActivityLogNote(
      "Full codebase analysis complete: src/main.ts, src/turn.ts, src/session.ts",
    );
    expect(warning).toContain("activity log");
  });

  it("accepts semantic finding notes", () => {
    const warning = detectActivityLogNote(
      "turn.ts uses piStream() for streaming; text_delta events are forwarded via onTextDelta",
    );
    expect(warning).toBeNull();
  });
});
