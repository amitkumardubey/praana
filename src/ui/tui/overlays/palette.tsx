/**
 * Slash command palette — centered list + detail-pane picker.
 * Opens when the prompt buffer becomes exactly "/"; the palette owns the
 * query from then on (the prompt keeps just the "/").
 */
import { createMemo, createSignal, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useBindings } from "@opentui/keymap/solid";
import type { InputRenderable } from "@opentui/core";
import { SLASH_COMMAND_METADATA } from "../../../slash-commands.js";
import { TUI_PALETTE, TUI_STYLE, truncatePlainText } from "../theme.js";
import { OverlayFrame } from "./frame.js";
import {
  buildPaletteItems,
  commandNeedsArgument,
  filterPaletteItems,
  type PaletteItem,
} from "./palette-items.js";

const LIST_WIDTH = 22;
const MAX_VISIBLE = 12;
const DETAIL_MIN_COLS = 64;
const SELECTED_BG = "#3a3e4b";

export interface PaletteOverlayProps {
  /** Run a no-argument command through the normal slash dispatch. */
  onRun: (command: string) => void;
  /** Seed the prompt with `"/name "` for argument-taking commands (also Tab). */
  onInsert: (text: string) => void;
  /** Query contains "/" — hand the text back to the prompt for path completion. */
  onHandoff: (text: string) => void;
  onCancel: () => void;
}

export function PaletteOverlay(props: PaletteOverlayProps) {
  const dimensions = useTerminalDimensions();
  let input: InputRenderable | undefined;
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  const items = createMemo(() => buildPaletteItems(SLASH_COMMAND_METADATA));
  const filtered = createMemo(() => filterPaletteItems(items(), query()));
  const selected = createMemo<PaletteItem | undefined>(
    () => filtered()[selectedIndex()],
  );
  const showDetail = createMemo(
    () => (dimensions().width || 80) >= DETAIL_MIN_COLS,
  );
  const frameWidth = createMemo(() =>
    Math.min(showDetail() ? 78 : 40, (dimensions().width || 80) - 8),
  );

  const scrollStart = createMemo(() => {
    const total = filtered().length;
    const visible = Math.min(MAX_VISIBLE, total);
    return Math.min(
      Math.max(0, selectedIndex() - visible + 1),
      Math.max(0, total - visible),
    );
  });
  const visibleItems = createMemo(() =>
    filtered().slice(scrollStart(), scrollStart() + MAX_VISIBLE),
  );

  const insert = (item: PaletteItem) => props.onInsert(`${item.name} `);
  const smartSelect = (item: PaletteItem) => {
    if (commandNeedsArgument(item)) insert(item);
    else props.onRun(item.name);
  };

  useBindings(() => ({
    target: () => input,
    targetMode: "focus",
    bindings: [
      {
        key: "up",
        cmd: () => setSelectedIndex((i) => Math.max(0, i - 1)),
      },
      {
        key: "down",
        cmd: () =>
          setSelectedIndex((i) => Math.min(filtered().length - 1, i + 1)),
      },
      {
        key: "tab",
        cmd: () => {
          const item = selected();
          if (item) insert(item);
        },
      },
    ],
  }));

  return (
    <OverlayFrame
      width={frameWidth()}
      backgroundColor="#2a2d37"
      borderColor="#3d414d"
    >
      <input
        ref={(el: InputRenderable) => {
          input = el;
        }}
        focused
        placeholder="type to filter commands…"
        onInput={(v: string) => {
          if (v.includes("/")) {
            props.onHandoff(`/${v}`);
            return;
          }
          setQuery(v);
          setSelectedIndex(0);
        }}
        onSubmit={() => {
          const item = selected();
          if (item) smartSelect(item);
        }}
      />
      <box flexDirection="row" flexGrow={1} minHeight={1}>
        <box flexDirection="column" width={LIST_WIDTH} flexShrink={0}>
          <For each={visibleItems()}>
            {(item, i) => {
              const isSelected = () => scrollStart() + i() === selectedIndex();
              return (
                <box
                  flexDirection="row"
                  backgroundColor={isSelected() ? SELECTED_BG : undefined}
                >
                  <text fg={TUI_PALETTE.coral}>
                    {isSelected() ? "▌" : " "}
                  </text>
                  <text fg={TUI_PALETTE.brand}>
                    {truncatePlainText(item.name, LIST_WIDTH - 2)}
                  </text>
                </box>
              );
            }}
          </For>
          <Show when={filtered().length === 0}>
            <text>
              <span style={TUI_STYLE.muted}>
                no matches — "/" hands off to path mode
              </span>
            </text>
          </Show>
        </box>
        <Show when={showDetail() && selected()}>
          {(item) => (
            <box flexDirection="column" flexGrow={1} paddingLeft={2}>
              <text>
                <span style={TUI_STYLE.brand}>{item().name}</span>
                <Show when={item().argumentHint}>
                  {(hint) => <span style={TUI_STYLE.accent}> {hint()}</span>}
                </Show>
              </text>
              <text>
                <span style={TUI_STYLE.chromeMuted}>{item().description}</span>
              </text>
              <text>
                <span style={TUI_STYLE.chromeMuted}>
                  aliases:{" "}
                  {item().aliases.length > 0 ? item().aliases.join(", ") : "—"}
                </span>
              </text>
              <text>
                <span style={TUI_STYLE.chromeMuted}>
                  category: {item().category}
                </span>
              </text>
            </box>
          )}
        </Show>
      </box>
      <text>
        <span style={TUI_STYLE.muted}>
          ↑↓ navigate · ↵ run/insert · tab insert · esc close ·{" "}
          {filtered().length} shown
        </span>
      </text>
    </OverlayFrame>
  );
}
