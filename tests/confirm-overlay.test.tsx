/**
 * Step-pause confirm overlay. Enter continues and Esc stops only after the
 * arm delay. Ctrl+C is not consumed, including during that window, so the
 * global handler can abort the turn.
 */
import { describe, expect, it } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { render } from "@opentui/solid";
import { createComponent } from "solid-js";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings } from "@opentui/keymap/solid";
import { classifyStepPauseKey, classifyYesNoKey, ConfirmOverlay, CONFIRM_ARM_MS, formatConfirmQuestion } from "../src/ui/tui/overlays/confirm.js";
import { createOverlayUi } from "../src/ui/tui/overlays/state.js";
import { focusPromptAfterConfirm } from "../src/ui/tui/run.tsx";

function PauseHarness(props: {
  overlay: ReturnType<typeof createOverlayUi>;
  armMs: number;
  onCtrlC: () => void;
  onEnter: () => void;
}) {
  useBindings(() => ({
    priority: 1,
    bindings: [
      { key: "ctrl+c", cmd: () => props.onCtrlC() },
      { key: "enter", cmd: () => props.onEnter() },
      { key: "return", cmd: () => props.onEnter() },
    ],
  }));
  return createComponent(ConfirmOverlay, { overlay: props.overlay, armMs: props.armMs });
}

async function mount(
  armMs: number,
  hooks?: { onCtrlC?: () => void; onEnter?: () => void; signal?: AbortSignal; mode?: "step" | "yesno"; message?: string },
) {
  const overlay = createOverlayUi();
  const pending = overlay.showConfirm(hooks?.message ?? "Continue?", hooks?.signal, {
    mode: hooks?.mode ?? "step",
  });
  const setup = await createTestRenderer({ width: 80, height: 24 });
  const keymap = createDefaultOpenTuiKeymap(setup.renderer);
  const onCtrlC = hooks?.onCtrlC ?? (() => {});
  const onEnter = hooks?.onEnter ?? (() => {});
  await render(
    () =>
      createComponent(KeymapProvider, {
        keymap,
        get children() {
          return createComponent(PauseHarness, { overlay, armMs, onCtrlC, onEnter });
        },
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

  it("classifies Ctrl+C as a hard abort inside and outside the arm window", () => {
    expect(classifyStepPauseKey("c", true, false)).toBe("passthrough");
    expect(classifyStepPauseKey("c", true, true)).toBe("passthrough");
    expect(classifyStepPauseKey("escape", false, false)).toBe("ignore");
    expect(classifyStepPauseKey("esc", false, true)).toBe("stop");
    expect(classifyStepPauseKey("enter", false, false)).toBe("ignore");
    expect(classifyStepPauseKey("return", false, true)).toBe("continue");
  });

  it("shows the continue, summarise, and abort hint", async () => {
    const { setup, overlay } = await mount(0);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Enter = continue");
    expect(frame).toContain("Esc = stop and summarise");
    expect(frame).toContain("Ctrl+C = abort");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("ignores Enter while the arm window is open", async () => {
    const { setup, pending, overlay } = await mount(60_000);
    setup.mockInput.pressEnter();
    expect(await stillPending(pending)).toBe(true);
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("ignores Esc while the arm window is open", async () => {
    const { setup, pending, overlay } = await mount(60_000);
    setup.mockInput.pressEscape();
    expect(await settledSoon(pending)).toEqual({ settled: false });
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("does not stop when a second Esc follows a palette dismiss inside the arm window", async () => {
    const overlay = createOverlayUi();
    overlay.showPalette();
    const pending = overlay.showConfirm("Continue?");
    expect(overlay.kind()).toBe("palette");
    overlay.dismiss();
    expect(overlay.kind()).toBe("confirm");
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const keymap = createDefaultOpenTuiKeymap(setup.renderer);
    await render(
      () =>
        createComponent(KeymapProvider, {
          keymap,
          get children() {
            return createComponent(ConfirmOverlay, { overlay, armMs: 60_000 });
          },
        }),
      setup.renderer,
    );
    for (let i = 0; i < 4; i++) await setup.renderOnce();
    await setup.flush();
    setup.mockInput.pressEscape();
    expect(await settledSoon(pending)).toEqual({ settled: false });
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("lets Ctrl+C abort during the arm window without resolving the confirm itself", async () => {
    const abort = new AbortController();
    let ctrlC = 0;
    let enters = 0;
    let focuses = 0;
    const { setup, pending, overlay } = await mount(60_000, {
      signal: abort.signal,
      onCtrlC: () => {
        ctrlC += 1;
        abort.abort();
      },
      onEnter: () => {
        enters += 1;
      },
    });
    setup.mockInput.pressCtrlC();
    expect(ctrlC).toBe(1);
    const settled = await settledSoon(pending);
    expect(settled).toEqual({ settled: true, value: false });
    expect(overlay.kind()).toBe("none");
    expect(overlay.confirmPrompt()).toBeNull();
    await setup.flush();
    setup.mockInput.pressEnter();
    expect(enters).toBe(1);
    focusPromptAfterConfirm(overlay.kind(), () => {
      focuses += 1;
    });
    expect(focuses).toBe(1);
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("lets Ctrl+C abort after the arm window without a confirm-owned stop", async () => {
    const abort = new AbortController();
    let ctrlC = 0;
    const { setup, pending, overlay } = await mount(0, {
      signal: abort.signal,
      onCtrlC: () => {
        ctrlC += 1;
        abort.abort();
      },
    });
    setup.mockInput.pressCtrlC();
    expect(ctrlC).toBe(1);
    expect(await settledSoon(pending)).toEqual({ settled: true, value: false });
    expect(overlay.kind()).toBe("none");
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

describe("classifyYesNoKey", () => {
  it("ignores every key during the arm window", () => {
    for (const key of ["y", "Y", "n", "enter", "escape", "x"]) {
      expect(classifyYesNoKey(key, false, false)).toBe("ignore");
    }
  });

  it("accepts y and Y once armed", () => {
    expect(classifyYesNoKey("y", false, true)).toBe("yes");
    expect(classifyYesNoKey("Y", false, true)).toBe("yes");
  });

  it("declines on n, Enter, and Esc once armed", () => {
    expect(classifyYesNoKey("n", false, true)).toBe("no");
    expect(classifyYesNoKey("N", false, true)).toBe("no");
    expect(classifyYesNoKey("enter", false, true)).toBe("no");
    expect(classifyYesNoKey("return", false, true)).toBe("no");
    expect(classifyYesNoKey("escape", false, true)).toBe("no");
    expect(classifyYesNoKey("esc", false, true)).toBe("no");
  });

  it("swallows other keys without answering", () => {
    for (const key of ["x", "space", "tab", "up", "1"]) {
      expect(classifyYesNoKey(key, false, true)).toBe("ignore");
    }
  });

  it("passes Ctrl+C through inside and outside the arm window", () => {
    expect(classifyYesNoKey("c", true, true)).toBe("passthrough");
    expect(classifyYesNoKey("c", true, false)).toBe("passthrough");
    // Ctrl+C keeps its abort meaning even though `c` alone does nothing.
    expect(classifyYesNoKey("c", false, true)).toBe("ignore");
  });

  it("drops the terminal-only [y/N] suffix for display", () => {
    expect(formatConfirmQuestion("Fetch https://bun.sh/docs? [y/N]", "yesno")).toBe(
      "Fetch https://bun.sh/docs?",
    );
    expect(formatConfirmQuestion("shell: rm -rf tmp", "yesno")).toBe("shell: rm -rf tmp");
    expect(formatConfirmQuestion("Used 5 steps this turn. Continue?", "step")).toBe(
      "Used 5 steps this turn. Continue?",
    );
  });
});

describe("ConfirmOverlay yes/no mode", () => {
  it("shows the risk question without [y/N] and the yes/no hint", async () => {
    const { setup, overlay } = await mount(0, {
      mode: "yesno",
      message: "Fetch https://bun.sh/docs? [y/N]",
    });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Fetch https://bun.sh/docs?");
    expect(frame).not.toContain("[y/N]");
    expect(frame).toContain("y = yes");
    expect(frame).toContain("n / Enter / Esc = no");
    expect(frame).toContain("Ctrl+C = abort");
    setup.renderer.destroy();
    overlay.dispose();
  });

  it("accepts on y once armed", async () => {
    const { setup, pending } = await mount(0, { mode: "yesno", message: "ok? [y/N]" });
    setup.mockInput.pressKey("y");
    expect(await pending).toBe(true);
    setup.renderer.destroy();
  });

  it("declines on Enter and Esc once armed", async () => {
    const enter = await mount(0, { mode: "yesno" });
    enter.setup.mockInput.pressEnter();
    expect(await enter.pending).toBe(false);
    enter.setup.renderer.destroy();

    const esc = await mount(0, { mode: "yesno" });
    esc.setup.mockInput.pressEscape();
    expect(await esc.pending).toBe(false);
    esc.setup.renderer.destroy();
  });

  it("ignores the answer keys while the arm window is open", async () => {
    const { setup, pending, overlay } = await mount(60_000, { mode: "yesno" });
    setup.mockInput.pressKey("y");
    setup.mockInput.pressEnter();
    expect(await stillPending(pending)).toBe(true);
    setup.renderer.destroy();
    overlay.dispose();
  });
});
