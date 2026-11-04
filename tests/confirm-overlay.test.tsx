/**
 * Step-pause confirm overlay: keys are swallowed immediately. Enter does
 * nothing until the arm delay elapses. Esc and Ctrl+C stop at any time,
 * including while that window is still open.
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

async function settledSoon(pending: Promise<boolean>): Promise<{ settled: true; value: boolean } | { settled: false }> {
  return Promise.race([
    pending.then((value) => ({ settled: true as const, value })),
    new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 40)),
  ]);
}

describe("ConfirmOverlay arm delay", () => {
  it("uses a 100ms arm delay by default", () => {
    expect(CONFIRM_ARM_MS).toBe(100);
  });

  it("ignores Enter while the arm window is open", async () => {
    const { setup, pending, overlay } = await mount(60_000);
    setup.mockInput.pressEnter();
    expect(await stillPending(pending)).toBe(true);
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("stops on Esc while the arm window is open", async () => {
    const { setup, pending, overlay } = await mount(60_000);
    setup.mockInput.pressEscape();
    expect(await settledSoon(pending)).toEqual({ settled: true, value: false });
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("stops on Ctrl+C while the arm window is open", async () => {
    const { setup, pending, overlay } = await mount(60_000);
    setup.mockInput.pressCtrlC();
    expect(await settledSoon(pending)).toEqual({ settled: true, value: false });
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("arms Enter again for a second confirm that does not remount the overlay", async () => {
    const { setup, pending, overlay } = await mount(40);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = overlay.showConfirm("second?");
    overlay.resolveConfirm(true);
    expect(await pending).toBe(true);
    expect(overlay.confirmPrompt()?.message).toBe("second?");
    setup.mockInput.pressEnter();
    expect(await stillPending(second)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    setup.mockInput.pressEnter();
    expect(await second).toBe(true);
    setup.renderer.destroy();
    overlay.dispose();
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
