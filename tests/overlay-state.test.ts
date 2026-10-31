/**
 * Solid overlay state machine (Phase 3/5).
 */
import { describe, expect, it } from "bun:test";
import { createOverlayUi } from "../src/ui/tui/overlays/state.js";

describe("createOverlayUi", () => {
  it("cycles slash / model / login / logout and dismisses", () => {
    const ui = createOverlayUi();
    expect(ui.kind()).toBe("none");

    ui.showSlash(["a", "b"]);
    expect(ui.kind()).toBe("slash");
    expect(ui.slashLines()).toEqual(["a", "b"]);

    ui.showModel();
    expect(ui.kind()).toBe("model");

    ui.showLogin("anthropic");
    expect(ui.kind()).toBe("login");
    expect(ui.loginHint()).toBe("anthropic");

    ui.showLogout("claude");
    expect(ui.kind()).toBe("logout");
    expect(ui.logoutHint()).toBe("claude");

    ui.showPalette();
    expect(ui.kind()).toBe("palette");

    ui.dismiss();
    expect(ui.kind()).toBe("none");
    expect(ui.slashLines()).toEqual([]);
    expect(ui.loginHint()).toBeUndefined();
    expect(ui.logoutHint()).toBeUndefined();
    ui.dispose();
  });

  async function expectStopped(pending: Promise<boolean>): Promise<void> {
    const result = await Promise.race([
      pending.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        setTimeout(() => resolve({ settled: false }), 50);
      }),
    ]);
    expect(result).toEqual({ settled: true, value: false });
  }

  it("resolves a pending confirm with stop on every transition, including showConfirm", async () => {
    const ui = createOverlayUi();

    const first = ui.showConfirm("first?");
    ui.showModel();
    await expectStopped(first);
    expect(ui.kind()).toBe("model");

    const replaced = ui.showConfirm("replaced?");
    const next = ui.showConfirm("next?");
    await expectStopped(replaced);
    expect(ui.kind()).toBe("confirm");
    expect(ui.confirmPrompt()?.message).toBe("next?");
    ui.resolveConfirm(true);
    expect(await next).toBe(true);

    const transitions: Array<(ui: ReturnType<typeof createOverlayUi>) => void> = [
      (overlay) => overlay.showSlash(["line"]),
      (overlay) => overlay.showModel(),
      (overlay) => overlay.showLogin("anthropic"),
      (overlay) => overlay.showLogout("openai"),
      (overlay) => overlay.showPalette(),
      (overlay) => overlay.showSetup(),
      (overlay) => overlay.showConsent(),
      (overlay) => overlay.dismiss(),
    ];
    for (const transition of transitions) {
      const pending = ui.showConfirm("still open?");
      transition(ui);
      await expectStopped(pending);
    }

    const disposed = ui.showConfirm("dispose?");
    ui.dispose();
    await expectStopped(disposed);
  });
});
