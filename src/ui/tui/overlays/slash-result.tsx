/**
 * Slash-command result overlay — any key dismisses (handled by OverlayHost).
 */
import { For } from "solid-js";
import { TUI_STYLE } from "../theme.js";
import { OverlayFrame } from "./frame.js";

export function SlashResultOverlay(props: { lines: string[] }) {
  return (
    <OverlayFrame width={72} maxHeight={18}>
      <scrollbox flexGrow={1} scrollY stickyScroll={false}>
        <For each={props.lines}>
          {(line) => <text>{line.length === 0 ? " " : TUI_STYLE.text(line)}</text>}
        </For>
      </scrollbox>
    </OverlayFrame>
  );
}
