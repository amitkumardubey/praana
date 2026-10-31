/**
 * Slash palette default ordering: useful, non-destructive commands first and
 * session-ending / state-wiping commands last, so the initial highlight is
 * never a destructive command. Typed queries keep ranking by match quality.
 */
import { describe, expect, it } from "bun:test";
import {
  buildPaletteItems,
  DESTRUCTIVE_COMMANDS,
  filterPaletteItems,
  orderPaletteItems,
  type PaletteItem,
} from "../src/ui/tui/overlays/palette-items.js";
import { SLASH_COMMAND_METADATA } from "../src/slash-commands.js";

const items = buildPaletteItems(SLASH_COMMAND_METADATA);
const names = (list: PaletteItem[]) => list.map((i) => i.name);

/** Commands that must be reachable in the first screenful. */
const USEFUL_FIRST = ["/help", "/model", "/sessions", "/settings"];

describe("palette default ordering", () => {
  it("opens on /help, never on a destructive command", () => {
    expect(items[0]?.name).toBe("/help");
    expect(DESTRUCTIVE_COMMANDS.has(items[0]!.name)).toBe(false);
  });

  it("keeps every destructive command in the trailing block", () => {
    const firstDestructive = items.findIndex((i) =>
      DESTRUCTIVE_COMMANDS.has(i.name),
    );
    expect(firstDestructive).toBeGreaterThan(0);
    for (const item of items.slice(firstDestructive)) {
      expect(DESTRUCTIVE_COMMANDS.has(item.name)).toBe(true);
    }
    // The whole known destructive set is present exactly once.
    expect(names(items.slice(firstDestructive)).sort()).toEqual(
      [...DESTRUCTIVE_COMMANDS].filter((c) => c !== "/quit").sort(),
    );
  });

  it("surfaces /help, /model, /sessions, /settings before any destructive command", () => {
    const firstDestructive = items.findIndex((i) =>
      DESTRUCTIVE_COMMANDS.has(i.name),
    );
    const tail = names(items.slice(firstDestructive));
    for (const name of USEFUL_FIRST) {
      expect(tail).not.toContain(name);
    }
    const firstScreenful = names(items.slice(0, 12));
    for (const name of USEFUL_FIRST) expect(firstScreenful).toContain(name);
  });

  it("keeps category metadata on reordered items", () => {
    const byName = new Map(items.map((i) => [i.name, i]));
    expect(byName.get("/help")?.category).toBe("Insight");
    expect(byName.get("/model")?.category).toBe("Model & Config");
    expect(byName.get("/exit")?.category).toBe("Session");
    expect(byName.get("/exit")?.aliases).toEqual(["/quit"]);
  });

  it("bare query preserves the curated (destructive-last) order", () => {
    expect(names(filterPaletteItems(items, ""))).toEqual(names(items));
    expect(filterPaletteItems(items, "")[0]?.name).toBe("/help");
  });

  it("typing /exit still ranks /exit first", () => {
    expect(filterPaletteItems(items, "exit")[0]?.name).toBe("/exit");
    expect(filterPaletteItems(items, "ex")[0]?.name).toBe("/exit");
  });

  it("typing /new still ranks /new first", () => {
    expect(filterPaletteItems(items, "new")[0]?.name).toBe("/new");
  });

  it("orderPaletteItems is a stable partition", () => {
    const sample: PaletteItem[] = [
      { name: "/exit", description: "", aliases: [], category: "Session" },
      { name: "/help", description: "", aliases: [], category: "Insight" },
      { name: "/clear", description: "", aliases: [], category: "Session" },
      { name: "/model", description: "", aliases: [], category: "Model & Config" },
    ];
    expect(names(orderPaletteItems(sample))).toEqual([
      "/help",
      "/model",
      "/exit",
      "/clear",
    ]);
  });

  it("orderPaletteItems leaves an all-destructive list untouched", () => {
    const sample: PaletteItem[] = [
      { name: "/exit", description: "", aliases: [], category: "Session" },
      { name: "/new", description: "", aliases: [], category: "Session" },
    ];
    expect(names(orderPaletteItems(sample))).toEqual(["/exit", "/new"]);
  });
});
