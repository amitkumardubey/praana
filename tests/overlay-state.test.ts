/**
 * Solid overlay state machine (Phase 3/5).
 *
 * A pending step-pause confirm takes priority: other show* calls wait until
 * it resolves or its signal aborts, and they do not count as "stop".
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

  async function settled(pending: Promise<boolean>): Promise<{ settled: true; value: boolean } | { settled: false }> {
    return Promise.race([
      pending.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => {
        setTimeout(() => resolve({ settled: false }), 30);
      }),
    ]);
  }

  it("keeps a step-pause confirm in front of other overlays until it is answered", async () => {
    const ui = createOverlayUi();
    const pending = ui.showConfirm("continue?");
    ui.showSlash(["later"]);
    ui.showModel();
    expect(ui.kind()).toBe("confirm");
    expect(ui.confirmPrompt()?.message).toBe("continue?");
    expect(await settled(pending)).toEqual({ settled: false });

    ui.resolveConfirm(true);
    expect(await pending).toBe(true);
    expect(ui.kind()).toBe("model");
    ui.dispose();
  });

  it("runs a queued confirm after the one that is already open", async () => {
    const ui = createOverlayUi();
    const first = ui.showConfirm("first?");
    const second = ui.showConfirm("second?");
    expect(ui.kind()).toBe("confirm");
    expect(ui.confirmPrompt()?.message).toBe("first?");
    expect(await settled(second)).toEqual({ settled: false });

    ui.resolveConfirm(true);
    expect(await first).toBe(true);
    expect(ui.kind()).toBe("confirm");
    expect(ui.confirmPrompt()?.message).toBe("second?");
    ui.resolveConfirm(false);
    expect(await second).toBe(false);
    expect(ui.kind()).toBe("none");
    ui.dispose();
  });

  it("closes the confirm when its signal aborts and then opens the deferred overlay", async () => {
    const ui = createOverlayUi();
    const abort = new AbortController();
    const pending = ui.showConfirm("continue?", abort.signal);
    ui.showLogin("anthropic");
    expect(ui.kind()).toBe("confirm");
    abort.abort();
    expect(await pending).toBe(false);
    expect(ui.kind()).toBe("login");
    expect(ui.loginHint()).toBe("anthropic");
    ui.dispose();
  });

  it("does not open a confirm that is already aborted", async () => {
    const ui = createOverlayUi();
    const abort = new AbortController();
    abort.abort();
    expect(await ui.showConfirm("continue?", abort.signal)).toBe(false);
    expect(ui.kind()).toBe("none");
    ui.dispose();
  });

  it("dismiss and dispose stop the confirm and drop a queued overlay", async () => {
    const ui = createOverlayUi();
    const pending = ui.showConfirm("still open?");
    const queued = ui.showConfirm("queued?");
    ui.showPalette();
    ui.dismiss();
    expect(await pending).toBe(false);
    expect(await queued).toBe(false);
    expect(ui.kind()).toBe("none");

    const disposed = ui.showConfirm("dispose?");
    ui.dispose();
    expect(await disposed).toBe(false);
  });
});
