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
});
