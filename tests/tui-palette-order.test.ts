/**
 * Slash palette default ordering: useful, non-destructive commands first and
 * session-ending / state-wiping commands last, so the initial highlight is
 * never a destructive command. Typed queries keep ranking by match quality.
 */
import { describe, expect, it } from "bun:test";
import {
  buildPaletteItems,
  filterPaletteItems,
  orderPaletteItems,
  type PaletteItem,
} from "../src/ui/tui/overlays/palette-items.js";
import { SLASH_COMMAND_METADATA } from "../src/slash-commands.js";

const items = buildPaletteItems(SLASH_COMMAND_METADATA);
const names = (list: PaletteItem[]) => list.map((i) => i.name);

/** Commands that must be reachable in the first screenful. */
const USEFUL_FIRST = ["/help", "/model", "/sessions", "/settings"];

/** Session-ending / state-wiping commands. Each must carry `destructive: true`. */
const REQUIRED_DESTRUCTIVE = ["/exit", "/new", "/clear", "/logout"];

describe("palette default ordering", () => {
  it("opens on /help, never on a destructive command", () => {
    expect(items[0]?.name).toBe("/help");
    expect(items[0]?.destructive).not.toBe(true);
  });

  it("keeps every destructive command in the trailing block", () => {
    const firstDestructive = items.findIndex((i) => i.destructive === true);
    expect(firstDestructive).toBeGreaterThan(0);
    for (const item of items.slice(firstDestructive)) {
      expect(item.destructive).toBe(true);
    }
    expect(names(items.slice(firstDestructive)).sort()).toEqual(
      [...REQUIRED_DESTRUCTIVE].sort(),
    );
  });

  it("surfaces /help, /model, /sessions, /settings before any destructive command", () => {
    const firstDestructive = items.findIndex((i) => i.destructive === true);
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
      { name: "/exit", description: "", aliases: [], category: "Session", destructive: true },
      { name: "/help", description: "", aliases: [], category: "Insight" },
      { name: "/clear", description: "", aliases: [], category: "Session", destructive: true },
      { name: "/model", description: "", aliases: [], category: "Model & Config" },
    ];
    expect(names(orderPaletteItems(sample))).toEqual([
      "/help",
      "/model",
      "/exit",
      "/clear",
    ]);
  });

  it("flags every hard-coded destructive command, and the highlight is never one", () => {
    for (const name of REQUIRED_DESTRUCTIVE) {
      const meta = SLASH_COMMAND_METADATA.find((c) => c.name === name);
      expect(meta?.destructive, name).toBe(true);
    }
    expect(items[0]?.destructive).not.toBe(true);
  });

  it("orderPaletteItems partitions on the destructive flag, not the command name", () => {
    const sample: PaletteItem[] = [
      { name: "/exit", description: "", aliases: ["/quit"], category: "Session" },
      { name: "/help", description: "", aliases: [], category: "Insight", destructive: true },
    ];
    expect(names(orderPaletteItems(sample))).toEqual(["/exit", "/help"]);
  });

  it("orderPaletteItems leaves an all-destructive list untouched", () => {
    const sample: PaletteItem[] = [
      { name: "/exit", description: "", aliases: [], category: "Session", destructive: true },
      { name: "/new", description: "", aliases: [], category: "Session", destructive: true },
    ];
    expect(names(orderPaletteItems(sample))).toEqual(["/exit", "/new"]);
  });
});
