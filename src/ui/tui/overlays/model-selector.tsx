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
import { RGBA, type InputRenderable } from "@opentui/core";
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
/** Explicit transparent bg — OpenTUI won't repaint a row whose bg flips to undefined. */
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

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
        // Compute the initial selection against the ORDERED list (current
        // pinned to top), not the raw entries — selectedIndex indexes into
        // filtered()/ordered(), so an index from the unsorted list lands on
        // the wrong row when the current model isn't in the catalog.
        const ordered = orderModels(entries, props.currentProvider, props.currentModelId);
        setSelectedIndex(
          initialSelectionIndex(ordered, props.currentProvider, props.currentModelId),
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
        </text>
      </Show>
    </OverlayFrame>
  );
}
