import { describe, it, expect } from "bun:test";
import { createModelSelectorController } from "../src/ui/tui/overlays/model-selector.js";
import type { ModelListEntry } from "../src/model-listing.js";

function m(provider: string, modelId: string): ModelListEntry {
  return { provider, modelId, label: modelId, contextWindow: null, available: true };
}

const models: ModelListEntry[] = [
  { provider: "openai", modelId: "gpt-4o", label: "gpt-4o", contextWindow: 128_000, available: true },
  { provider: "openai", modelId: "gpt-4o-mini", label: "gpt-4o-mini", contextWindow: null, available: true },
  { provider: "anthropic", modelId: "claude-sonnet-4", label: "claude-sonnet-4", contextWindow: 200_000, available: true },
];

describe("createModelSelectorController", () => {
  it("first static snapshot stops loading, reports pending/failures, and seeds selection", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "gpt-4o" });
    const sel = c.onUpdate(models, { pending: 2, failed: [] });

    expect(c.state.loading).toBe(false);
    expect(c.state.updating).toBe(true);
    expect(c.state.failures).toEqual([]);
    expect(c.state.entries).toBe(models);
    // Current model pinned to top by orderModels -> seed index 0.
    expect(sel).toBe(0);
  });

  it("seeds the first available model when the current model is not listed", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "not-in-list" });
    const sel = c.onUpdate(models, { pending: 0, failed: [] });
    expect(sel).toBe(0); // gpt-4o is the first available row
  });

  it("later live merges never re-seed the selection", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "gpt-4o" });
    c.onUpdate(models, { pending: 1, failed: [] });

    const more: ModelListEntry[] = [
      ...models,
      { provider: "openai", modelId: "late-model", label: "late-model", contextWindow: null, available: true },
    ];
    const sel = c.onUpdate(more, { pending: 0, failed: [] });
    expect(sel).toBeNull();
    expect(c.state.entries).toBe(more);
    expect(c.state.updating).toBe(false);
  });

  it("collects per-provider failures as inline notes without erroring", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "gpt-4o" });
    c.onUpdate(models, { pending: 1, failed: ["openrouter: catalog unreachable"] });
    expect(c.state.failures).toEqual(["openrouter: catalog unreachable"]);
    expect(c.state.loading).toBe(false);
  });

  it("onFinal seeds when no snapshot ever arrived, and clears pending state", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "gpt-4o" });
    const sel = c.onFinal(models);
    expect(sel).toBe(0);
    expect(c.state.updating).toBe(false);
    expect(c.state.failures).toEqual([]);
  });

  it("ignores late updates after dispose (selector closed)", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "gpt-4o" });
    c.onUpdate(models, { pending: 1, failed: [] });
    c.dispose();

    const late = c.onUpdate([...models, { provider: "openai", modelId: "late", label: "late", contextWindow: null, available: true }], { pending: 0, failed: [] });
    expect(late).toBeNull();
    expect(c.state.entries).toBe(models); // unchanged
    expect(c.onFinal(models)).toBeNull();
    expect(c.state.loading).toBe(false);
  });

  it("loading stays true until the first snapshot", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "gpt-4o" });
    expect(c.state.loading).toBe(true);
  });

  it("onFinal keeps the failures reported by the last onUpdate (live catalog note survives)", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "gpt-4o" });
    c.onUpdate(models, { pending: 0, failed: ["ollama: catalog unreachable"] });
    const sel = c.onFinal(models);
    expect(sel).toBeNull();
    expect(c.state.failures).toEqual(["ollama: catalog unreachable"]);
  });

  it("keeps loading while the static snapshot is empty and live fetches are still pending", () => {
    const c = createModelSelectorController({ currentProvider: "ollama", currentModelId: "llama3.1" });
    const sel = c.onUpdate([], { pending: 3, failed: [] });
    expect(sel).toBeNull();
    expect(c.state.loading).toBe(true);
    expect(c.state.updating).toBe(true);
    expect(c.state.entries).toEqual([]);
  });

  it("seeds once a live merge delivers a non-empty snapshot after an empty static one", () => {
    const c = createModelSelectorController({ currentProvider: "ollama", currentModelId: "llama3.1" });
    c.onUpdate([], { pending: 3, failed: [] });
    const live = [m("ollama", "llama3.1")];
    const sel = c.onUpdate(live, { pending: 0, failed: [] });
    expect(sel).toBe(0);
    expect(c.state.loading).toBe(false);
  });

  it("treats an empty final snapshot (pending 0) as loaded", () => {
    const c = createModelSelectorController({ currentProvider: "ollama", currentModelId: "llama3.1" });
    const sel = c.onUpdate([], { pending: 0, failed: [] });
    expect(sel).toBe(0);
    expect(c.state.loading).toBe(false);
  });

  it("exposes a disposed flag that flips on dispose", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "gpt-4o" });
    expect(c.disposed).toBe(false);
    c.dispose();
    expect(c.disposed).toBe(true);
  });

  it("onReject reports the load error while open and is a no-op after dispose", () => {
    const c = createModelSelectorController({ currentProvider: "openai", currentModelId: "gpt-4o" });
    const msg = c.onReject(new Error("catalog unreachable"));
    expect(msg).toBe("catalog unreachable");
    expect(c.state.loading).toBe(false);

    c.dispose();
    const after = c.onReject(new Error("late rejection"));
    expect(after).toBeNull();
    expect(c.state.loading).toBe(false); // unchanged
    expect(c.state.entries).toEqual([]);
  });
});
