import { describe, it, expect } from "bun:test";
import { createModelSelectorController } from "../src/ui/tui/overlays/model-selector.js";
import type { ModelListEntry } from "../src/model-listing.js";

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
});
