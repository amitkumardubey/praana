/**
 * Renderer-level tests for the slash-result overlay.
 *
 * These mount the real SlashResultOverlay through the OpenTUI Solid renderer:
 * - On a short terminal the frame must be clamped by `computeSlashFrameMaxHeight`
 *   (not the constant 18), so content collapses into a scrollable box with the
 *   hint row instead of growing past the terminal.
 * - Scroll keys must only be consumed while there is actual overflow; otherwise
 *   they must fall through to lower-priority intercepts (the host's
 *   dismiss-on-any-key handler), exactly like any other key.
 *
 * The client solid-js runtime is installed by preload (see
 * tests/helpers/solid-client.ts and bunfig.toml).
 */
import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createComponent } from "solid-js";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import {
  computeSlashFrameMaxHeight,
  SlashResultOverlay,
} from "../src/ui/tui/overlays/slash-result.js";

const EIGHT_LINES = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`);
const SHORT = ["/help", "usage: praana [command]", "just three lines"];

interface BoxLike {
  id?: string;
  _heightValue?: number;
  getChildren?: () => unknown[];
}

function findById(node: unknown, id: string): BoxLike | undefined {
  const n = node as BoxLike;
  if (n.id === id) return n;
  for (const child of n.getChildren?.() ?? []) {
    const found = findById(child, id);
    if (found) return found;
  }
  return undefined;
}

async function mount(height: number, lines: string[]) {
  const setup = await createTestRenderer({ width: 80, height });
  const keymap = createDefaultOpenTuiKeymap(setup.renderer);
  await render(
    () =>
      createComponent(KeymapProvider, {
        keymap,
        children: () => createComponent(SlashResultOverlay, { lines }),
      }),
    setup.renderer,
  );
  for (let i = 0; i < 8; i++) await setup.renderOnce();
  await setup.flush();
  return { setup, keymap };
}

describe("SlashResultOverlay renderer", () => {
  it("clamps the frame to the terminal-derived max height on a short terminal", async () => {
    const { setup } = await mount(14, EIGHT_LINES);

    const frame = findById(setup.renderer.root, "overlay-frame");

    // On a 14-row terminal the frame's max height is min(18, max(8, 14-6))
    // = 8. The frame must not grow to 12 rows (8 lines + chrome) just because
    // the max height prop is the constant 18: the overlay passes the derived
    // clamp to OverlayFrame, so 8 lines collapse into the capped frame.
    expect(frame?._heightValue).toBe(computeSlashFrameMaxHeight(14));
    expect(frame?._heightValue).toBe(8);
    expect(frame?._heightValue).toBeLessThan(EIGHT_LINES.length + 4);

    setup.renderer.destroy();
  });

  it("lets scroll keys fall through when nothing overflows", async () => {
    const { setup, keymap } = await mount(40, SHORT);

    // Simulate OverlayHost's dismiss-on-any-key intercept: a lower-priority
    // listener that must still receive scroll keys while the content fits.
    const seen: string[] = [];
    const off = keymap.intercept(
      "key",
      (ctx) => {
        seen.push(ctx.event.name);
      },
      { priority: 0 },
    );

    setup.mockInput.pressArrow("down");
    setup.mockInput.pressArrow("up");
    setup.mockInput.pressKey("\u001B[5~"); // pageup
    setup.mockInput.pressKey("\u001B[6~"); // pagedown

    expect(seen).toContain("down");
    expect(seen).toContain("up");
    expect(seen).toContain("pageup");
    expect(seen).toContain("pagedown");

    off();
    setup.renderer.destroy();
  });
});
