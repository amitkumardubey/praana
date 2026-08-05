# Model Selector Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite the `/model` bare selector as a palette-styled, keyboard-navigable picker (fixes "only the first item selectable").

**Architecture:** Replace the imperative OpenTUI `<select>` widget (which never receives keyboard focus) with a manual `For`-rendered list whose `selectedIndex` is a parent-owned signal advanced by `useBindings` up/down/tab targeting the focused search input — the exact pattern proven in the slash palette. Pure selection logic lives in a new unit-testable module `model-selector-items.ts`.

**Tech Stack:** TypeScript strict, Bun (bun:test), SolidJS + OpenTUI (`@opentui/solid`, `@opentui/keymap/solid`).

**Spec:** `docs/superpowers/specs/2026-08-05-model-selector-redesign-design.md`
**Branch:** `feat/ad/opentui-solid`

---

### Task 1: Pure model-selector helpers + failing tests

**Files:**
- Create: `src/ui/tui/overlays/model-selector-items.ts`
- Test: `tests/model-selector-items.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/model-selector-items.test.ts`:

```ts
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
  it("fuzzy-matches provider", () => {
    const r = filterModelItems(L, "openai");
    expect(r.every((x) => x.provider === "openai")).toBe(true);
  });
  it("fuzzy-matches model id", () => {
    const r = filterModelItems(L, "haiku");
    expect(r[0]?.modelId).toBe("claude-haiku");
  });
});

describe("scrollStartOf", () => {
  it("keeps selection visible in a window", () => {
    expect(scrollStartOf(5, 20, 10)).toBe(0);
    expect(scrollStartOf(15, 20, 10)).toBe(10);
    expect(scrollStartOf(19, 20, 10)).toBe(10);
    expect(scrollStartOf(0, 3, 10)).toBe(0);
  });
});

describe("initialSelectionIndex", () => {
  it("selects the current model when present", () => {
    expect(initialSelectionIndex(L, "anthropic", "claude-sonnet-4-5")).toBe(1);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/model-selector-items.test.ts`
Expected: FAIL — module `../src/ui/tui/overlays/model-selector-items.js` not found.

- [ ] **Step 3: Write the minimal implementation**

Create `src/ui/tui/overlays/model-selector-items.ts`:

```ts
/**
 * Pure helpers for the model selector: ordering, filtering, scroll window,
 * and navigation that skips unavailable rows. No Solid/OpenTUI imports —
 * unit-testable.
 */
import { formatCtx, fuzzyFilter, type ModelListEntry } from "../../../model-listing.js";

/** Current model pinned to top; otherwise provider, then model id. */
export function orderModels(
  entries: ModelListEntry[],
  currentProvider: string,
  currentModelId: string,
): ModelListEntry[] {
  return [...entries].sort((a, b) => {
    const aCurrent = a.provider === currentProvider && a.modelId === currentModelId;
    const bCurrent = b.provider === currentProvider && b.modelId === currentModelId;
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;
    const byProvider = a.provider.localeCompare(b.provider);
    if (byProvider !== 0) return byProvider;
    return a.modelId.localeCompare(b.modelId);
  });
}

/** Bare query preserves order; else fuzzy over provider + model id. */
export function filterModelItems(
  entries: ModelListEntry[],
  query: string,
): ModelListEntry[] {
  const q = query.trim();
  if (!q) return entries;
  return fuzzyFilter(entries, q, (m) => `${m.provider} ${m.modelId} ${m.provider}/${m.modelId}`);
}

/** First visible index for a scroll window (palette scroll math). */
export function scrollStartOf(
  selectedIndex: number,
  total: number,
  visible: number,
): number {
  return Math.min(
    Math.max(0, selectedIndex - visible + 1),
    Math.max(0, total - visible),
  );
}

/** The selection the picker should open on. */
export function initialSelectionIndex(
  list: ModelListEntry[],
  currentProvider: string,
  currentModelId: string,
): number {
  const idx = list.findIndex(
    (m) => m.provider === currentProvider && m.modelId === currentModelId,
  );
  if (idx >= 0) return idx;
  const first = list.findIndex((m) => m.available);
  return first === -1 ? 0 : first;
}

/** Move selection in `direction` (1 down, -1 up), skipping unavailable rows. */
export function moveSelection(
  list: ModelListEntry[],
  from: number,
  direction: 1 | -1,
): number {
  let i = from + direction;
  while (i >= 0 && i < list.length) {
    if (list[i].available) return i;
    i += direction;
  }
  if (list[from]?.available) return from;
  const first = list.findIndex((m) => m.available);
  return first === -1 ? 0 : first;
}

/** Single-line list-row text: `modelId [provider] ctx`. */
export function formatModelRow(m: ModelListEntry): string {
  const ctx = formatCtx(m.contextWindow);
  return `${m.modelId} [${m.provider}]${ctx ? ` ${ctx}` : ""}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/model-selector-items.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/ui/tui/overlays/model-selector-items.ts tests/model-selector-items.test.ts
git commit -m "feat: model selector pure helpers (order, filter, nav) + tests"
```

---

### Task 2: Rewrite the model selector component

**Files:**
- Modify: `src/ui/tui/overlays/model-selector.tsx` (full rewrite)

- [ ] **Step 1: Replace the component**

Replace the entire contents of `src/ui/tui/overlays/model-selector.tsx` with:

```tsx
/**
 * Palette-styled model selector — replaces the imperative <select> version
 * whose selection never advanced (only the first item was selectable).
 * Manual For-rendered list; selectedIndex is a parent-owned signal advanced
 * by useBindings targeting the focused search input (same pattern as the
 * slash palette).
 */
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { useTerminalDimensions, useRenderer } from "@opentui/solid";
import { useBindings } from "@opentui/keymap/solid";
import type { InputRenderable } from "@opentui/core";
import type { ModelListEntry } from "../../../model-listing.js";
import { TUI_PALETTE, TUI_STYLE, truncatePlainText } from "../theme.js";
import { OverlayFrame } from "./frame.js";
import {
  filterModelItems,
  formatModelRow,
  initialSelectionIndex,
  moveSelection,
  orderModels,
  scrollStartOf,
} from "./model-selector-items.js";

const MAX_VISIBLE = 10;
const DETAIL_MIN_COLS = 64;
const DETAIL_WIDTH = 26;
const SELECTED_BG = "#3a3e4b";

export interface ModelSelectorOverlayProps {
  currentProvider: string;
  currentModelId: string;
  maxVisible?: number;
  loadModels: () => Promise<ModelListEntry[]>;
  onSelect: (provider: string, modelId: string) => void;
  onCancel: () => void;
}

export function ModelSelectorOverlay(props: ModelSelectorOverlayProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  let input: InputRenderable | undefined;
  const [query, setQuery] = createSignal("");
  const [allModels, setAllModels] = createSignal<ModelListEntry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const maxVisible = () => props.maxVisible ?? MAX_VISIBLE;

  const ordered = createMemo(() =>
    orderModels(allModels(), props.currentProvider, props.currentModelId),
  );
  const filtered = createMemo(() => filterModelItems(ordered(), query()));
  const selected = createMemo(() => filtered()[selectedIndex()]);

  const showDetail = createMemo(
    () => (dimensions().width || 80) >= DETAIL_MIN_COLS,
  );
  const frameWidth = createMemo(() =>
    Math.min(showDetail() ? 72 : 48, (dimensions().width || 80) - 8),
  );
  const listWidth = createMemo(() =>
    Math.max(10, frameWidth() - (showDetail() ? DETAIL_WIDTH : 0) - 6),
  );

  const scrollStart = createMemo(() =>
    scrollStartOf(selectedIndex(), filtered().length, maxVisible()),
  );
  const visibleItems = createMemo(() =>
    filtered().slice(scrollStart(), scrollStart() + maxVisible()),
  );
  const isCurrent = (m: ModelListEntry) =>
    m.provider === props.currentProvider && m.modelId === props.currentModelId;

  onMount(() => {
    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const entries = await props.loadModels();
        setAllModels(entries);
        setSelectedIndex(
          initialSelectionIndex(entries, props.currentProvider, props.currentModelId),
        );
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        renderer.requestRender();
      }
    })();
  });

  createEffect(() => {
    const n = filtered().length;
    if (selectedIndex() >= n) setSelectedIndex(Math.max(0, n - 1));
  });

  const commitCurrent = () => {
    const item = selected();
    if (item && item.available) props.onSelect(item.provider, item.modelId);
  };

  useBindings(() => ({
    target: () => input,
    targetMode: "focus",
    bindings: [
      {
        key: "up",
        cmd: () => setSelectedIndex((i) => moveSelection(filtered(), i, -1)),
      },
      {
        key: "down",
        cmd: () => setSelectedIndex((i) => moveSelection(filtered(), i, 1)),
      },
      { key: "tab", cmd: () => commitCurrent() },
    ],
  }));

  return (
    <OverlayFrame
      width={frameWidth()}
      backgroundColor="#2a2d37"
      borderColor="#3d414d"
    >
      <text>
        <span style={TUI_STYLE.info}>Select model</span>
      </text>
      <input
        ref={(el: InputRenderable) => {
          input = el;
        }}
        focused
        placeholder="search models…"
        onInput={(v: string) => {
          setQuery(v);
          setSelectedIndex(0);
        }}
        onSubmit={() => commitCurrent()}
      />
      <Show when={loading()}>
        <text>
          <span style={TUI_STYLE.muted}>loading models…</span>
        </text>
      </Show>
      <Show when={loadError()}>
        {(err) => (
          <text>
            <span style={TUI_STYLE.error}>{err()}</span>
          </text>
        )}
      </Show>
      <Show when={!loading() && !loadError()}>
        <box flexDirection="row" flexGrow={1} minHeight={1}>
          <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={10}>
            <For each={visibleItems()}>
              {(item, i) => {
                const rowIndex = scrollStart() + i();
                const isSel = rowIndex === selectedIndex();
                return (
                  <box
                    flexDirection="row"
                    backgroundColor={isSel ? SELECTED_BG : undefined}
                  >
                    <text fg={TUI_PALETTE.coral}>
                      {isSel ? "▌" : " "}
                    </text>
                    <text
                      fg={
                        item.available
                          ? TUI_PALETTE.brand
                          : TUI_PALETTE.steelMuted
                      }
                    >
                      {truncatePlainText(formatModelRow(item), listWidth() - 1)}
                    </text>
                  </box>
                );
              }}
            </For>
            <Show when={filtered().length === 0}>
              <text>
                <span style={TUI_STYLE.muted}>no matching models</span>
              </text>
            </Show>
          </box>
          <Show when={showDetail() && selected()}>
            {(item) => (
              <box
                flexDirection="column"
                width={DETAIL_WIDTH}
                flexShrink={0}
                paddingLeft={2}
              >
                <text>
                  <span style={TUI_STYLE.brand}>{item().modelId}</span>
                </text>
                <text>
                  <span style={TUI_STYLE.accent}>{item().provider}</span>
                </text>
                <text>
                  <span style={TUI_STYLE.chromeMuted}>
                    {formatModelRow(item()).replace(item().modelId, "").trim()}
                  </span>
                </text>
                <text>
                  {isCurrent(item()) ? (
                    <span style={TUI_STYLE.onFlag}>current model ✓</span>
                  ) : item().available ? (
                    <span style={TUI_STYLE.chromeMuted}>selectable</span>
                  ) : (
                    <span style={TUI_STYLE.warning}>
                      {item().disabledReason ?? "unavailable"}
                    </span>
                  )}
                </text>
              </box>
            )}
          </Show>
        </box>
        <text>
          <span style={TUI_STYLE.muted}>
            ↑↓ navigate · ↵ select · tab select · esc close ·{" "}
            {filtered().length} shown
          </span>
        </text>
      </Show>
    </OverlayFrame>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `bun typecheck`
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/tui/overlays/model-selector.tsx
git commit -m "feat: rewrite model selector with keyboard-navigable palette list"
```

---

### Task 3: Verify interactively and run the gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `bun typecheck && bun test`
Expected: typecheck clean; full suite passes.

- [ ] **Step 2: Interactive verification (interminai)**

Start the app under a PTY via the interminai skill, size ~100x30, run `bun dev`, then step through:

1. Open the selector: `/model` + Enter.
2. **Current model pinned to top with `✓`** — first row is the current model.
3. **Press Down 2×** → the highlight moves down two rows (bug fix: selection advances).
4. **Press Up 1×** → highlight moves up one row.
5. **This time select a non-first model** (Down once, then Enter) → toast shows the switch to that model (confirms not always the first item).
6. **Filter**: type `claude` → list narrows; the selected row stays visible.
7. **Esc** → selector closes, prompt intact.
8. Open again, **type a provider substring** (e.g. `open`) and Enter → switches to a matching model.
9. Re-open and confirm the **detail pane** (right side) shows model id, provider, ctx, and `current model ✓` / availability.

Stop the interminai session when done.

- [ ] **Step 3: Commit any accrued docs**

```bash
git add -A
git commit -m "docs: model selector verification notes"   # only if docs changed; otherwise skip
```

---

## Self-Review

- **Spec coverage:** Layout/styling (Task 2) ✓; data & ordering/current-pin ✓ (orderModels, initialSelectionIndex); scroll window ✓ (scrollStartOf); filter ✓ (filterModelItems); keyboard up/down/tab/enter ✓ (Task 2 useBindings + onSubmit); skip-unavailable ✓ (moveSelection + commitCurrent availability guard); detail pane ✓ (Task 2); footer ✓; reused formatCtx ✓ (formatModelRow wraps it); files & tests ✓ (Task 1 + 2); interactive verify ✓ (Task 3). `handleModelSelect` in run.tsx unchanged ✓.
- **Placeholder scan:** all code steps contain full code; no TBD/TODO.
- **Type consistency:** `formatModelRow(m)` used in both list rows (Task 2) and its own test (Task 1) with same signature `(ModelListEntry) => string`; `moveSelection(list, from, direction)` matches call sites `(filtered(), i, 1|-1)`; `scrollStartOf(selectedIndex, total, visible)` matches call `(selectedIndex(), filtered().length, maxVisible())`; helper names in component imports match exports in the helpers file.
