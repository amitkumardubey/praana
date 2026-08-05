/**
 * Slash palette pure logic: item building, fuzzy filtering, smart-run rule,
 * metadata category coverage.
 */
import { describe, expect, it } from "bun:test";
import { SLASH_COMMAND_METADATA } from "../src/slash-commands.js";

const VALID_CATEGORIES = ["Session", "Memory", "Model & Config", "Tools", "Insight"];

describe("slash metadata categories", () => {
  it("every command has a valid category", () => {
    for (const meta of SLASH_COMMAND_METADATA) {
      expect(VALID_CATEGORIES).toContain(meta.category);
    }
  });

  it("every category is non-empty", () => {
    const used = new Set(SLASH_COMMAND_METADATA.map((m) => m.category));
    for (const c of VALID_CATEGORIES) expect(used.has(c as never)).toBe(true);
  });
});
