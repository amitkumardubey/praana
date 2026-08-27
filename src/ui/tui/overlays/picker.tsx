/**
 * Palette-styled list used by /model, and now login / setup / logout.
 * Manual For-rendered rows (native <select> only highlights the first item).
 */
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useBindings } from "@opentui/keymap/solid";
import { RGBA, type InputRenderable } from "@opentui/core";
import { TUI_PALETTE, TUI_STYLE, truncatePlainText } from "../theme.js";
import {
  filterPickerOptions,
  scrollStartOf,
  type PaletteListOption,
} from "./picker-items.js";

export type { PaletteListOption };

const MAX_VISIBLE = 10;
const DETAIL_MIN_COLS = 64;
const DETAIL_WIDTH = 26;
const SELECTED_BG = "#3a3e4b";
const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

export interface PaletteListProps {
  options: PaletteListOption[];
  onSelect: (value: string) => void;
  placeholder?: string;
  maxVisible?: number;
  emptyLabel?: string;
  initialQuery?: string;
}

export function PaletteList(props: PaletteListProps) {
  const dimensions = useTerminalDimensions();
  let input: InputRenderable | undefined;
  const [query, setQuery] = createSignal(props.initialQuery ?? "");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const maxVisible = () => props.maxVisible ?? MAX_VISIBLE;
  const filtered = createMemo(() => filterPickerOptions(props.options, query()));
  const selected = createMemo(() => filtered()[selectedIndex()]);
  const showDetail = createMemo(
    () => (dimensions().width || 80) >= DETAIL_MIN_COLS,
  );
  const listWidth = createMemo(() =>
    Math.max(12, (dimensions().width || 80) - (showDetail() ? DETAIL_WIDTH + 16 : 16)),
  );

  const scrollStart = createMemo(() =>
    scrollStartOf(selectedIndex(), filtered().length, maxVisible()),
  );
  const visibleItems = createMemo(() =>
    filtered().slice(scrollStart(), scrollStart() + maxVisible()),
  );

  createEffect(() => {
    const n = filtered().length;
    if (selectedIndex() >= n) setSelectedIndex(Math.max(0, n - 1));
  });

  onMount(() => {
    const seed = props.initialQuery?.trim();
    if (seed && input) input.value = seed;
  });

  const commitCurrent = () => {
    const item = selected();
    if (item) props.onSelect(item.value);
  };

  const move = (delta: -1 | 1) => {
    setSelectedIndex((i) => {
      const next = i + delta;
      return Math.max(0, Math.min(filtered().length - 1, next));
    });
  };

  useBindings(() => ({
    target: () => input,
    targetMode: "focus",
    bindings: [
      { key: "up", cmd: () => move(-1) },
      { key: "down", cmd: () => move(1) },
      { key: "tab", cmd: () => commitCurrent() },
    ],
  }));

  return (
    <box flexDirection="column" flexGrow={1} minHeight={1}>
      <input
        ref={(el: InputRenderable) => {
          input = el;
        }}
        focused
        placeholder={props.placeholder ?? "search…"}
        onInput={(v: string) => {
          setQuery(v);
          setSelectedIndex(0);
        }}
        onSubmit={() => commitCurrent()}
      />
      <box flexDirection="row" flexGrow={1} minHeight={1}>
        <box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={10}>
          <For each={visibleItems()}>
            {(item, i) => {
              const isSel = () => scrollStart() + i() === selectedIndex();
              return (
                <box
                  flexDirection="row"
                  backgroundColor={isSel() ? SELECTED_BG : TRANSPARENT}
                >
                  <text fg={TUI_PALETTE.coral}>{isSel() ? "▌" : " "}</text>
                  <text fg={TUI_PALETTE.brand}>
                    {truncatePlainText(item.name, Math.max(8, listWidth() - 2))}
                  </text>
                </box>
              );
            }}
          </For>
          <Show when={filtered().length === 0}>
            <text>
              <span style={TUI_STYLE.muted}>
                {props.emptyLabel ?? "no matches"}
              </span>
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
                <span style={TUI_STYLE.brand}>{item().name}</span>
              </text>
              <Show when={item().description}>
                <text>
                  <span style={TUI_STYLE.chromeMuted}>{item().description}</span>
                </text>
              </Show>
            </box>
          )}
        </Show>
      </box>
      <text>
        <span style={TUI_STYLE.muted}>
          ↑↓ navigate · ↵ select · esc close · {filtered().length} shown
        </span>
      </text>
    </box>
  );
}
