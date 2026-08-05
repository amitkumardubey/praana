import { describe, expect, it } from "bun:test";
import type { ModelListEntry } from "../src/model-listing.js";
import {
  filterModelItems,
  formatModelRow,
  initialSelectionIndex,
  moveSelection,
  orderModels,
  scrollStartOf,
} from "../src/ui/tui/overlays/model-selector-items.js";

function m(provider: string, modelId: string, p: Partial<ModelListEntry> = {}): ModelListEntry {
  return { provider, modelId, label: modelId, contextWindow: null, available: true, ...p };
}

const L: ModelListEntry[] = [
  m("anthropic", "claude-sonnet-4-5", { contextWindow: 200_000 }),
  m("openai", "gpt-4o", { contextWindow: 128_000 }),
  m("openai", "gpt-4o-mini", { contextWindow: 128_000, available: false, disabledReason: "no key" }),
  m("anthropic", "claude-haiku"),
];

describe("orderModels", () => {
  it("pins the current model to the top", () => {
    const out = orderModels(L, "openai", "gpt-4o");
    expect(out[0]).toMatchObject({ provider: "openai", modelId: "gpt-4o" });
  });
  it("keeps provider-then-id order otherwise", () => {
    const out = orderModels(L, "openai", "gpt-4o").slice(1).map((x) => x.modelId);
    expect(out).toEqual(["claude-haiku", "claude-sonnet-4-5", "gpt-4o-mini"]);
  });
  it("does not mutate the input", () => {
    const copy = [...L];
    orderModels(L, "x", "y");
    expect(L).toEqual(copy);
  });
});

describe("filterModelItems", () => {
  it("bare query returns input order", () => {
    expect(filterModelItems(L, "")).toBe(L);
  });
  it("fuzzy-matches provider (openai ranked first)", () => {
    const r = filterModelItems(L, "openai");
    expect(r[0]?.provider).toBe("openai");
    expect(r.some((x) => x.provider === "openai")).toBe(true);
  });
  it("fuzzy-matches model id", () => {
    const r = filterModelItems(L, "haiku");
    expect(r[0]?.modelId).toBe("claude-haiku");
  });
});

describe("scrollStartOf", () => {
  it("keeps selection visible in a window", () => {
    expect(scrollStartOf(5, 20, 10)).toBe(0);
    expect(scrollStartOf(15, 20, 10)).toBe(6);
    expect(scrollStartOf(19, 20, 10)).toBe(10);
    expect(scrollStartOf(0, 3, 10)).toBe(0);
  });
});

describe("initialSelectionIndex", () => {
  it("selects the current model when present", () => {
    expect(initialSelectionIndex(L, "anthropic", "claude-sonnet-4-5")).toBe(0);
  });
  it("falls back to first available when current absent", () => {
    expect(initialSelectionIndex(L, "google", "gemini")).toBe(0);
  });
  it("handles empty list", () => {
    expect(initialSelectionIndex([], "a", "b")).toBe(0);
  });
});

describe("moveSelection", () => {
  it("moves down skipping unavailable rows", () => {
    // gpt-4o(idx1) -> skip gpt-4o-mini(unavailable) -> claude-haiku(idx3)
    expect(moveSelection(L, 1, 1)).toBe(3);
  });
  it("bounded at the ends", () => {
    expect(moveSelection(L, 0, -1)).toBe(0);
  });
  it("stays when no further selectable in that direction", () => {
    expect(moveSelection(L, 0, 1)).toBe(1);
    expect(moveSelection(L, 0, -1)).toBe(0);
  });
});

describe("formatModelRow", () => {
  it("formats model + provider + ctx", () => {
    expect(formatModelRow(L[0])).toBe("claude-sonnet-4-5 [anthropic] 200k ctx");
  });
  it("omits ctx when null", () => {
    expect(formatModelRow(L[3])).toBe("claude-haiku [anthropic]");
  });
});
