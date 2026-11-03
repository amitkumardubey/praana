/**
 * Step-pause confirm overlay: keys are swallowed immediately, and Enter / Esc
 * do nothing until the arm delay elapses.
 */
import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createComponent } from "solid-js";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { ConfirmOverlay, CONFIRM_ARM_MS } from "../src/ui/tui/overlays/confirm.js";
import { createOverlayUi } from "../src/ui/tui/overlays/state.js";

async function mount(armMs: number) {
  const overlay = createOverlayUi();
  const pending = overlay.showConfirm("Continue?");
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const keymap = createDefaultOpenTuiKeymap(setup.renderer);
  await render(
    () =>
      createComponent(KeymapProvider, {
        keymap,
        children: () => createComponent(ConfirmOverlay, { overlay, armMs }),
      }),
    setup.renderer,
  );
  for (let i = 0; i < 4; i++) await setup.renderOnce();
  await setup.flush();
  return { setup, pending, overlay };
}

async function stillPending(pending: Promise<boolean>): Promise<boolean> {
  const result = await Promise.race([
    pending.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20)),
  ]);
  return result;
}

describe("ConfirmOverlay arm delay", () => {
  it("uses a 100ms arm delay by default", () => {
    expect(CONFIRM_ARM_MS).toBe(100);
  });

  it("ignores Enter and Esc until the arm delay has passed", async () => {
    const { setup, pending } = await mount(60_000);
    setup.mockInput.pressEnter();
    setup.mockInput.pressEscape();
    expect(await stillPending(pending)).toBe(true);
    setup.renderer.destroy();
  });

  it("continues on Enter once armed", async () => {
    const { setup, pending } = await mount(0);
    setup.mockInput.pressEnter();
    expect(await pending).toBe(true);
    setup.renderer.destroy();
  });

  it("stops on Esc once armed", async () => {
    const { setup, pending } = await mount(0);
    setup.mockInput.pressEscape();
    expect(await pending).toBe(false);
    setup.renderer.destroy();
  });
});
