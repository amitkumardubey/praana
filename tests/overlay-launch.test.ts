import { describe, it, expect } from "bun:test";
import {
  createOverlayUi,
  launchCanvasHiddenForOverlay,
  type OverlayKind,
} from "../src/ui/tui/overlays/state.js";

describe("launch canvas visibility per overlay kind", () => {
  it("shows the launch canvas when no overlay is open", () => {
    expect(launchCanvasHiddenForOverlay("none")).toBe(false);
  });

  it("keeps the launch canvas for palette / slash / model overlays", () => {
    for (const kind of ["palette", "slash", "model"] as OverlayKind[]) {
      expect(launchCanvasHiddenForOverlay(kind)).toBe(false);
    }
  });

  it("hides the launch canvas for the full-screen modals that bleed through", () => {
    for (const kind of ["setup", "consent", "login"] as OverlayKind[]) {
      expect(launchCanvasHiddenForOverlay(kind)).toBe(true);
    }
  });

  it("dismissing every overlay restores the canvas", () => {
    const overlay = createOverlayUi();
    overlay.showSetup();
    expect(launchCanvasHiddenForOverlay(overlay.kind())).toBe(true);
    overlay.showPalette();
    expect(launchCanvasHiddenForOverlay(overlay.kind())).toBe(false);
    overlay.dismiss();
    expect(launchCanvasHiddenForOverlay(overlay.kind())).toBe(false);
    overlay.dispose();
  });
});
