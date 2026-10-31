/**
 * Palette-styled model selector — replaces the imperative <select> version
 * whose selection never advanced (only the first item was selectable).
 * Manual For-rendered list; selectedIndex is a parent-owned signal advanced
 * by useBindings targeting the focused search input (same pattern as the
 * slash palette).
 */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { useTerminalDimensions, useRenderer } from "@opentui/solid";
import { useBindings } from "@opentui/keymap/solid";
import { RGBA, type InputRenderable } from "@opentui/core";
import type {
  ListAllAvailableModelsOptions,
  ModelListEntry,
  ModelListUpdateMeta,
} from "../../../model-listing.js";
import { TUI_PALETTE, TUI_STYLE, truncatePlainText } from "../theme.js";
import { OverlayFrame, OVERLAY_BACKGROUND, OVERLAY_BORDER } from "./frame.js";
import {
  filterModelItems,
  formatModelRow,
  initialSelectionIndex,
  moveSelection,
  orderModels,
  scrollStartOf,
} from "./model-selector-items.js";

/**
 * Pure controller for the selector's incremental-load state machine. Kept
 * outside the component so it is unit-testable without mounting Solid.
 *
 * Rules:
 * - the first non-empty snapshot — or the final result (pending 0) —
 *   flips `loading` off and seeds the selection once. An empty snapshot
 *   while live fetches are still pending (only live-catalog providers, or
 *   zero providers) must not show the empty-list message or waste the seed;
 * - later live merges never re-seed (they must not move the user's
 *   selection/scroll or clear a typed filter);
 * - once `dispose()` runs (selector closed), all further events are ignored
 *   so late live results never touch an unmounted component. `disposed` is
 *   exposed for the component to guard its post-await signal/renderer calls
 *   (including the load-failure path via `onReject`).
 */
export function createModelSelectorController(options: {
  currentProvider: string;
  currentModelId: string;
}) {
  let disposed = false;
  let selectionInitialized = false;
  let selectedIndex = 0;
  // True once the user has moved the selection or typed a filter; after that
  // the live-merge current-model acquisition below must never move it.
  let userInteracted = false;
  // Whether the seed already saw the current model (live-only providers only
  // deliver it with a merge, so we move the highlight to it exactly once).
  let currentModelSeeded = false;

  const state = {
    entries: [] as ModelListEntry[],
    loading: true,
    updating: false,
    failures: [] as string[],
  };

  const seedSelection = (entries: ModelListEntry[]): void => {
    const ordered = orderModels(
      entries,
      options.currentProvider,
      options.currentModelId,
    );
    selectedIndex = initialSelectionIndex(
      ordered,
      options.currentProvider,
      options.currentModelId,
    );
    currentModelSeeded = ordered.some(
      (m) =>
        m.provider === options.currentProvider &&
        m.modelId === options.currentModelId,
    );
    selectionInitialized = true;
  };

  const apply = (entries: ModelListEntry[], loadComplete: boolean): number | null => {
    if (disposed) return null;
    state.entries = entries;
    // Purely-live providers deliver an empty static snapshot while their
    // `/models` fetches are pending; keep `loading` on and hold the seed
    // until the snapshot is non-empty or the load is complete.
    if (entries.length === 0 && !loadComplete) return null;
    state.loading = false;
    if (!selectionInitialized) {
      seedSelection(entries);
      return selectedIndex;
    }
    // Live-only current model: when the static snapshot never contained it
    // and it only arrives with a live merge, move the highlight onto it the
    // first time it appears — unless the user already moved the selection or
    // typed a filter.
    if (!userInteracted && !currentModelSeeded) {
      const ordered = orderModels(
        entries,
        options.currentProvider,
        options.currentModelId,
      );
      const idx = ordered.findIndex(
        (m) =>
          m.provider === options.currentProvider &&
          m.modelId === options.currentModelId,
      );
      if (idx >= 0) {
        currentModelSeeded = true;
        selectedIndex = idx;
        return selectedIndex;
      }
    }
    return null;
  };

  return {
    dispose() {
      disposed = true;
    },
    /**
     * Record that the user has interacted (moved the selection or typed a
     * filter); the live-merge current-model acquisition will never move the
     * selection after this.
     */
    markUserInteracted(): void {
      userInteracted = true;
    },
    /** True once the selector closed; late load results must be dropped. */
    get disposed() {
      return disposed;
    },
    /** Incremental snapshot (static first, then live merges). */
    onUpdate(entries: ModelListEntry[], meta: ModelListUpdateMeta): number | null {
      if (disposed) return null;
      state.updating = meta.pending > 0;
      state.failures = meta.failed;
      return apply(entries, meta.pending === 0);
    },
    /** Final resolved list. */
    onFinal(entries: ModelListEntry[]): number | null {
      if (disposed) return null;
      state.updating = false;
      // Do not clear failures here: they are the last onUpdate's inline
      // "live catalog unavailable" note and must survive loading finishing.
      return apply(entries, true);
    },
    /**
     * Late load failure. While the selector is open, reports the message and
     * flips `loading` off; after dispose it is a silent no-op (no state
     * change, no throw) so a rejection after close cannot touch the UI.
     */
    onReject(err: unknown): string | null {
      if (disposed) return null;
      state.loading = false;
      return err instanceof Error ? err.message : String(err);
    },
    get state() {
      return state;
    },
  };
}

export interface ModelSelectionKey {
  provider: string;
  modelId: string;
}

/**
 * Selection state for the model selector, keyed by model identity instead of
 * a numeric row index. Live merges that insert rows before the highlighted
 * model keep the highlight on the same model: `reconcile` recomputes the
 * numeric index from the tracked key after every merge/filter change. When
 * the selected model leaves the visible list the key lapses and today's
 * numeric clamping applies.
 */
export class ModelSelection {
  private index = 0;
  private key: ModelSelectionKey | null = null;

  /** Numeric row index into the latest filtered list (render position). */
  get indexValue(): number {
    return this.index;
  }

  /** Identity of the highlighted model; null while nothing is selected. */
  get keyValue(): ModelSelectionKey | null {
    return this.key;
  }

  /**
   * Recompute the row index from the tracked model identity. The key is
   * kept as long as the model still exists in the unfiltered `all` list:
   * a filter that hides the model must not lose the selection — clearing
   * the filter restores it. The key lapses only when the model leaves the
   * full list.
   */
  reconcile(list: ModelListEntry[], all: ModelListEntry[] = list): void {
    if (this.key !== null && list.length > 0) {
      const idx = list.findIndex(
        (m) =>
          m.provider === this.key!.provider && m.modelId === this.key!.modelId,
      );
      if (idx >= 0) {
        this.index = idx;
        return;
      }
    }
    if (this.key !== null && all.length > 0) {
      const stillExists = all.some(
        (m) =>
          m.provider === this.key!.provider && m.modelId === this.key!.modelId,
      );
      if (stillExists) {
        // Keep the key; clamp the visible row index to the filtered list.
        if (this.index >= list.length) {
          this.index = Math.max(0, list.length - 1);
        }
        return;
      }
    }
    // Fallback: clamp as before; the key lapses so a later change does not
    // resurrect a selection the user could no longer see.
    if (this.index >= list.length) this.index = Math.max(0, list.length - 1);
    this.key = null;
  }

  /** Seed the initial selection (current model pinned / first available). */
  seed(index: number, list: ModelListEntry[]): void {
    this.index = index;
    this.setKeyAt(list, index);
  }

  /** Move up/down by visible row (skipping unavailable rows). */
  move(list: ModelListEntry[], direction: 1 | -1): void {
    this.index = moveSelection(list, this.index, direction);
    this.setKeyAt(list, this.index);
  }

  /** Jump to the top of the current (post-filter) list. */
  jumpToTop(list: ModelListEntry[]): void {
    this.index = 0;
    this.setKeyAt(list, 0);
  }

  private setKeyAt(list: ModelListEntry[], index: number): void {
    const entry = list[index];
    this.key = entry
      ? { provider: entry.provider, modelId: entry.modelId }
      : null;
  }
}

const MAX_VISIBLE = 10;
const DETAIL_MIN_COLS = 64;
const DETAIL_WIDTH = 26;
const SELECTED_BG = "#3a3e4b";
/** Explicit transparent bg — OpenTUI won't repaint a row whose bg flips to undefined. */
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

export interface ModelSelectorOverlayProps {
  currentProvider: string;
  currentModelId: string;
  maxVisible?: number;
  loadModels: (opts?: ListAllAvailableModelsOptions) => Promise<ModelListEntry[]>;
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
  /** Live `/models` fetches still running — static list is already usable. */
  const [updating, setUpdating] = createSignal(false);
  /** Inline (non-blocking) per-provider live-catalog failures. */
  const [liveFailures, setLiveFailures] = createSignal<string[]>([]);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const selection = new ModelSelection();
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

  let controller: ReturnType<typeof createModelSelectorController> | undefined;
  onMount(() => {
    const ctrl = createModelSelectorController({
      currentProvider: props.currentProvider,
      currentModelId: props.currentModelId,
    });
    controller = ctrl;

    const commitState = () => {
      const s = ctrl.state;
      setAllModels(s.entries);
      setLoading(s.loading);
      setUpdating(s.updating);
      setLiveFailures(s.failures);
      renderer.requestRender();
    };

    const seedSelectionAt = (sel: number, entries: ModelListEntry[]) => {
      // Seed against the ordered snapshot the controller computed `sel` for;
      // the reconcile effect re-adjusts if a typed filter differs.
      selection.seed(
        sel,
        orderModels(entries, props.currentProvider, props.currentModelId),
      );
      setSelectedIndex(sel);
    };

    const handleUpdate = (entries: ModelListEntry[], meta: ModelListUpdateMeta) => {
      if (ctrl.disposed) return;
      const sel = ctrl.onUpdate(entries, meta);
      if (sel !== null) seedSelectionAt(sel, entries);
      setLoadError(null);
      commitState();
    };

    void (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const entries = await props.loadModels({ onUpdate: handleUpdate });
        if (ctrl.disposed) return;
        const sel = ctrl.onFinal(entries);
        if (sel !== null) seedSelectionAt(sel, entries);
        setLoadError(null);
        commitState();
      } catch (err) {
        // Only reached when every selected provider failed AND nothing was
        // produced — the static snapshot already shown keeps this off.
        // After dispose the controller reports null: drop everything without
        // touching signals or the renderer.
        const message = ctrl.onReject(err);
        if (message === null) return;
        setLoadError(message);
        setLoading(false);
        renderer.requestRender();
      }
    })();

    onCleanup(() => ctrl.dispose());
  });

  createEffect(() => {
    // Follow model identity: after any merge/filter change, recompute the
    // row index from the selected provider/modelId. Falls back to numeric
    // clamping when the selected model is no longer visible.
    selection.reconcile(filtered(), ordered());
    const idx = selection.indexValue;
    if (selectedIndex() !== idx) setSelectedIndex(idx);
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
        cmd: () => {
          controller?.markUserInteracted();
          selection.move(filtered(), -1);
          setSelectedIndex(selection.indexValue);
        },
      },
      {
        key: "down",
        cmd: () => {
          controller?.markUserInteracted();
          selection.move(filtered(), 1);
          setSelectedIndex(selection.indexValue);
        },
      },
      { key: "tab", cmd: () => commitCurrent() },
    ],
  }));

  return (
    <OverlayFrame
      width={frameWidth()}
      backgroundColor={OVERLAY_BACKGROUND}
      borderColor={OVERLAY_BORDER}
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
          controller?.markUserInteracted();
          setQuery(v);
          selection.jumpToTop(filtered());
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
                // Function (not const) so Solid re-evaluates it reactively when
                // selectedIndex changes — a const captures the value at render
                // time and goes stale, leaving deselected rows highlighted.
                const isSel = () => scrollStart() + i() === selectedIndex();
                return (
                  <box
                    flexDirection="row"
                    backgroundColor={isSel() ? SELECTED_BG : TRANSPARENT}
                  >
                    <text fg={TUI_PALETTE.coral}>
                      {isSel() ? "▌" : " "}
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
          <Show when={updating()}>
            <span style={TUI_STYLE.muted}> · updating…</span>
          </Show>
          <Show when={liveFailures().length > 0}>
            <span style={TUI_STYLE.muted}>
              {" "}· live catalog unavailable: {liveFailures().join(", ")}
            </span>
          </Show>
        </text>
      </Show>
    </OverlayFrame>
  );
}
