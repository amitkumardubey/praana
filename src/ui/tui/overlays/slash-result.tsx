/**
 * Slash-command result overlay.
 *
 * Up/Down/PageUp/PageDown scroll when the text is taller than the frame.
 * Scroll keys are consumed here (higher priority than OverlayHost) whether or
 * not they actually scroll, so they never reach the host's dismiss-on-any-key
 * handler; Esc/Enter/any other key still closes the overlay. A footer hint
 * shows only while the content overflows.
 *
 * Overflow is measured from layout events, not a poll: we re-measure on every
 * completed frame (content changes, the scrollbox mounting, and terminal
 * resize all produce frames) and only re-render when the overflow state
 * actually changes, so the measurement never loops.
 */
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { useKeymap } from "@opentui/keymap/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import { TUI_STYLE } from "../theme.js";
import { OverlayFrame } from "./frame.js";

const SCROLL_KEYS = new Set(["up", "down", "pageup", "pagedown"]);

/** Frame chrome: top/bottom borders + top/bottom padding. */
export const SLASH_FRAME_CHROME_ROWS = 4;
/** Footer hint row rendered only while overflowing. */
export const SLASH_HINT_ROWS = 1;
/** Maximum frame height, matching the <OverlayFrame maxHeight={18} /> prop. */
export const SLASH_FRAME_MAX_HEIGHT = 18;
/** Minimum frame height, matching OverlayFrame's floor. */
export const SLASH_FRAME_MIN_TERM_HEIGHT = 8;

/** Same max-height maths as OverlayFrame (width aside). */
export function computeSlashFrameMaxHeight(termHeight: number): number {
  return Math.min(
    SLASH_FRAME_MAX_HEIGHT,
    Math.max(SLASH_FRAME_MIN_TERM_HEIGHT, (termHeight || 24) - 6),
  );
}

/**
 * Scrollbox height when overflowing: the frame's available inner height minus
 * the footer hint row. Derived from the terminal height so a short terminal
 * (e.g. 14 rows) does not clip the hint.
 */
export function computeSlashScrollBoxHeight(
  termHeight: number,
  overflow: boolean,
): number {
  return Math.max(
    1,
    computeSlashFrameMaxHeight(termHeight) -
      SLASH_FRAME_CHROME_ROWS -
      (overflow ? SLASH_HINT_ROWS : 0),
  );
}

export function isSlashScrollKey(name: string): boolean {
  return SCROLL_KEYS.has(name);
}

export function SlashResultOverlay(props: { lines: string[] }) {
  const keymap = useKeymap();
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [overflow, setOverflow] = createSignal(false);
  const [scrollerReady, setScrollerReady] = createSignal(false);
  let scroller: ScrollBoxRenderable | undefined;

  const scrollRange = (): number => {
    if (!scroller) return 0;
    return Math.max(0, scroller.scrollHeight - scroller.viewport.height);
  };

  const measure = () => {
    if (!scroller) return;
    const next = scrollRange() > 0.5;
    if (next !== overflow()) {
      setOverflow(next);
      renderer.requestRender();
    }
  };

  // Layout-driven measurement: any frame that completes may reflect new
  // content or a new terminal size, so measure on every frame. requestRender
  // only fires when the overflow state flips, so this cannot loop.
  createEffect(() => {
    renderer.on("frame", measure);
    onCleanup(() => renderer.off("frame", measure));
  });

  // Ensure a frame is scheduled when content, terminal size, or the scrollbox
  // mount changes; the frame listener above performs the actual measurement.
  createEffect(() => {
    void props.lines.length;
    void dimensions().width;
    void dimensions().height;
    void scrollerReady();
    renderer.requestRender();
  });

  createEffect(() => {
    const off = keymap.intercept(
      "key",
      (ctx) => {
        const name = ctx.event.name;
        if (!isSlashScrollKey(name)) return;
        // Scroll keys must never reach OverlayHost's dismiss-on-any-key
        // handler — even before overflow is measured or with Shift held.
        if (scroller && scrollRange() > 0.5) {
          if (name === "up") scroller.scrollBy(-1);
          else if (name === "down") scroller.scrollBy(1);
          else if (name === "pageup") scroller.scrollBy(-0.5, "viewport");
          else scroller.scrollBy(0.5, "viewport");
          renderer.requestRender();
        }
        ctx.consume();
      },
      { priority: 100 },
    );
    onCleanup(off);
  });

  const scrollBoxHeight = () =>
    computeSlashScrollBoxHeight(dimensions().height, overflow());

  return (
    <OverlayFrame width={72} maxHeight={SLASH_FRAME_MAX_HEIGHT}>
      <scrollbox
        ref={(el: ScrollBoxRenderable) => {
          scroller = el;
          setScrollerReady(true);
        }}
        id="slash-result-scroll"
        flexGrow={overflow() ? 0 : 1}
        flexShrink={1}
        minHeight={1}
        height={overflow() ? scrollBoxHeight() : undefined}
        scrollY
        stickyScroll={false}
      >
        <For each={props.lines}>
          {(line) => <text>{line.length === 0 ? " " : line}</text>}
        </For>
      </scrollbox>
      <Show when={overflow()}>
        <text height={1} flexShrink={0}>
          <span style={TUI_STYLE.muted}>↑↓ scroll · enter/esc close</span>
        </text>
      </Show>
    </OverlayFrame>
  );
}
