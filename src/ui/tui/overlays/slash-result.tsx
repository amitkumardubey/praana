/**
 * Slash-command result overlay.
 *
 * Up/Down/PageUp/PageDown scroll when the text is taller than the frame.
 * Those keys are consumed here (higher priority than OverlayHost) so they
 * do not dismiss. Any other key still closes the overlay. A footer hint
 * shows only while the content overflows.
 */
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { useKeymap } from "@opentui/keymap/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import { TUI_STYLE } from "../theme.js";
import { OverlayFrame } from "./frame.js";

const SCROLL_KEYS = new Set(["up", "down", "pageup", "pagedown"]);

export function SlashResultOverlay(props: { lines: string[] }) {
  const keymap = useKeymap();
  const renderer = useRenderer();
  let scroller: ScrollBoxRenderable | undefined;
  const [overflow, setOverflow] = createSignal(false);

  const scrollRange = (): number => {
    if (!scroller) return 0;
    return Math.max(0, scroller.scrollHeight - scroller.viewport.height);
  };

  const measure = () => {
    setOverflow(scrollRange() > 0.5);
    renderer.requestRender();
  };

  createEffect(() => {
    void props.lines.length;
    let ticks = 0;
    const timer = setInterval(() => {
      measure();
      ticks += 1;
      if (ticks >= 8) clearInterval(timer);
    }, 50);
    onCleanup(() => clearInterval(timer));
  });

  createEffect(() => {
    const off = keymap.intercept(
      "key",
      (ctx) => {
        const name = ctx.event.name;
        if (!SCROLL_KEYS.has(name) || ctx.event.ctrl || ctx.event.meta || ctx.event.shift) return;
        if (scrollRange() <= 0.5) return;
        if (!scroller) return;
        if (name === "up") scroller.scrollBy(-1);
        else if (name === "down") scroller.scrollBy(1);
        else if (name === "pageup") scroller.scrollBy(-0.5, "viewport");
        else scroller.scrollBy(0.5, "viewport");
        renderer.requestRender();
        ctx.consume();
      },
      { priority: 100 },
    );
    onCleanup(off);
  });

  return (
    <OverlayFrame width={72} maxHeight={18}>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => {
          scroller = el;
        }}
        id="slash-result-scroll"
        flexGrow={overflow() ? 0 : 1}
        flexShrink={1}
        minHeight={1}
        height={overflow() ? 12 : undefined}
        scrollY
        stickyScroll={false}
      >
        <For each={props.lines}>
          {(line) => <text>{line.length === 0 ? " " : line}</text>}
        </For>
      </scrollbox>
      <Show when={overflow()}>
        <text height={1} flexShrink={0}>
          <span style={TUI_STYLE.muted}>↑↓ scroll · esc close</span>
        </text>
      </Show>
    </OverlayFrame>
  );
}
