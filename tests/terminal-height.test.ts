import { describe, it, expect } from "bun:test";
import {
  getTerminalRows,
  getTranscriptLineBudget,
} from "../src/ui/chat-shell/terminal-height.js";

describe("getTranscriptLineBudget", () => {
  it("reserves chrome below terminal row count", () => {
    const rows = getTerminalRows();
    const budget = getTranscriptLineBudget();
    expect(budget).toBeGreaterThanOrEqual(6);
    expect(budget).toBeLessThan(rows);
  });

  it("reduces budget when logo and toast are visible", () => {
    const base = getTranscriptLineBudget();
    const withChrome = getTranscriptLineBudget({
      showLogo: true,
      showToast: true,
      showScrollHint: true,
    });
    expect(withChrome).toBeLessThan(base);
  });
});
