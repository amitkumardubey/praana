/**
 * Slash palette pure logic: item building, fuzzy filtering, smart-run rule,
 * metadata category coverage.
 */
import { describe, expect, it } from "bun:test";
import {
  buildPaletteItems,
  commandNeedsArgument,
  filterPaletteItems,
} from "../src/ui/tui/overlays/palette-items.js";
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

describe("palette-items", () => {
  const items = buildPaletteItems(SLASH_COMMAND_METADATA);

  it("builds one item per canonical command (aliases folded in)", () => {
    expect(items.length).toBe(SLASH_COMMAND_METADATA.length);
    const exit = items.find((i) => i.name === "/exit");
    expect(exit?.aliases).toEqual(["/quit"]);
    expect(items.some((i) => i.name === "/quit")).toBe(false);
  });

  it("bare query returns curated metadata order", () => {
    const all = filterPaletteItems(items, "");
    expect(all.map((i) => i.name)).toEqual(items.map((i) => i.name));
  });

  it("fuzzy-matches on name", () => {
    const r = filterPaletteItems(items, "rec");
    expect(r[0]?.name).toBe("/recall");
  });

  it("matches via alias", () => {
    const r = filterPaletteItems(items, "qui");
    expect(r.some((i) => i.name === "/exit")).toBe(true);
  });

  it("no match returns empty", () => {
    expect(filterPaletteItems(items, "zzzzzz")).toEqual([]);
  });

  it("commandNeedsArgument: only required `<...>` hints", () => {
    const byName = (n: string) => items.find((i) => i.name === n)!;
    expect(commandNeedsArgument(byName("/recall"))).toBe(true);   // <query>
    expect(commandNeedsArgument(byName("/shell"))).toBe(true);    // <command>
    expect(commandNeedsArgument(byName("/why"))).toBe(true);      // <unit-id>
    expect(commandNeedsArgument(byName("/model"))).toBe(false);   // [provider] <id>
    expect(commandNeedsArgument(byName("/thinking"))).toBe(false); // on|off
    expect(commandNeedsArgument(byName("/help"))).toBe(false);    // no hint
  });
});
