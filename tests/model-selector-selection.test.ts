import { describe, it, expect } from "bun:test";
import { ModelSelection } from "../src/ui/tui/overlays/model-selector.js";
import { orderModels } from "../src/ui/tui/overlays/model-selector-items.js";
import type { ModelListEntry } from "../src/model-listing.js";

function m(provider: string, modelId: string): ModelListEntry {
  return { provider, modelId, label: modelId, contextWindow: null, available: true };
}

const CURRENT = { provider: "openai", modelId: "gpt-4o" };

const STATIC: ModelListEntry[] = [
  m("openai", "gpt-4o"),
  m("anthropic", "claude-sonnet-4"),
  m("openai", "gpt-4o-mini"),
];

describe("ModelSelection", () => {
  it("seeds the initial selection by index (current model pinned top)", () => {
    const sel = new ModelSelection();
    sel.seed(0, orderModels(STATIC, CURRENT.provider, CURRENT.modelId));
    expect(sel.indexValue).toBe(0);
    expect(sel.keyValue).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("keeps the selected model when a merge inserts rows before it", () => {
    const sel = new ModelSelection();
    const orderedStatic = orderModels(STATIC, CURRENT.provider, CURRENT.modelId);
    sel.seed(0, orderedStatic);
    sel.move(orderedStatic, 1); // row 1 = anthropic/claude-sonnet-4
    expect(sel.keyValue).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });

    // 30 models sort before claude-sonnet-4 (same provider, smaller ids).
    const merged = [
      ...STATIC,
      ...Array.from({ length: 30 }, (_, i) =>
        m("anthropic", `claude-${String(i).padStart(3, "0")}`),
      ),
    ];
    const ordered = orderModels(merged, CURRENT.provider, CURRENT.modelId);
    sel.reconcile(ordered);

    expect(sel.keyValue).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });
    expect(ordered[sel.indexValue]).toMatchObject({ modelId: "claude-sonnet-4" });
    // current pinned at 0, then 30 claude-* rows, then claude-sonnet-4.
    expect(sel.indexValue).toBe(31);
  });

  it("up/down navigation still works after a merge", () => {
    const sel = new ModelSelection();
    const orderedStatic = orderModels(STATIC, CURRENT.provider, CURRENT.modelId);
    sel.seed(0, orderedStatic);
    sel.move(orderedStatic, 1);

    const merged = [
      ...STATIC,
      ...Array.from({ length: 30 }, (_, i) =>
        m("anthropic", `claude-${String(i).padStart(3, "0")}`),
      ),
    ];
    const ordered = orderModels(merged, CURRENT.provider, CURRENT.modelId);
    sel.reconcile(ordered);
    expect(sel.indexValue).toBe(31);

    sel.move(ordered, 1);
    expect(sel.keyValue).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
    expect(ordered[sel.indexValue]).toMatchObject({ modelId: "gpt-4o-mini" });

    sel.move(ordered, -1);
    expect(sel.keyValue).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });
    expect(sel.indexValue).toBe(31);
  });

  it("falls back to numeric clamping when the selected model leaves the filtered list", () => {
    const sel = new ModelSelection();
    const orderedStatic = orderModels(STATIC, CURRENT.provider, CURRENT.modelId);
    sel.seed(0, orderedStatic);
    sel.move(orderedStatic, 2); // openai/gpt-4o-mini

    const filteredOut = [m("openai", "gpt-4o")]; // selection not present
    sel.reconcile(filteredOut);
    expect(sel.indexValue).toBe(0);
    expect(sel.keyValue).toBeNull(); // key lapses; numeric clamp as today
  });

  it("jumpToTop selects the first filtered row and tracks its identity", () => {
    const sel = new ModelSelection();
    sel.seed(0, orderModels(STATIC, CURRENT.provider, CURRENT.modelId));
    sel.move(orderModels(STATIC, CURRENT.provider, CURRENT.modelId), 1);

    const filtered = [m("anthropic", "claude-sonnet-4")];
    sel.jumpToTop(filtered);
    expect(sel.indexValue).toBe(0);
    expect(sel.keyValue).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });
  });
});
