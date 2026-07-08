import { describe, it, expect } from "bun:test";
import { providerPageLines } from "../src/interactive-setup.js";

describe("providerPageLines", () => {
  it("renders a single page without pagination hint", () => {
    const lines = providerPageLines(["openai", "anthropic"], 0, 10);
    expect(lines).toEqual([
      "  1. openai",
      "  2. anthropic",
      "",
    ]);
  });

  it("renders a full page with pagination hint", () => {
    const providers = Array.from({ length: 12 }, (_, i) => `provider-${i + 1}`);
    const lines = providerPageLines(providers, 0, 10);
    expect(lines).toHaveLength(12); // 10 items + blank + hint
    expect(lines[0]).toBe("  1. provider-1");
    expect(lines[9]).toBe("  10. provider-10");
    expect(lines[10]).toBe("");
    expect(lines[11]).toBe("  Page 1/2. Type 'n' for next, 'p' for previous.");
  });

  it("renders the last partial page", () => {
    const providers = Array.from({ length: 12 }, (_, i) => `provider-${i + 1}`);
    const lines = providerPageLines(providers, 1, 10);
    expect(lines).toEqual([
      "  11. provider-11",
      "  12. provider-12",
      "",
      "  Page 2/2. Type 'n' for next, 'p' for previous.",
    ]);
  });

  it("treats an empty list as one empty page", () => {
    const lines = providerPageLines([], 0, 10);
    expect(lines).toEqual([""]);
  });
});
