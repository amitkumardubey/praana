import { describe, it, expect, beforeEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ToastRegion } from "../src/ui/tui/toast-region.js";

describe("ToastRegion", () => {
  it("shows a message with tone glyph", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const toasts = new ToastRegion(setup.renderer);
      setup.renderer.root.add(toasts);
      toasts.show("Saved!", "success");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("Saved!");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("clearErrors removes sticky error toasts", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const toasts = new ToastRegion(setup.renderer);
      setup.renderer.root.add(toasts);
      toasts.show("boom", "error");
      toasts.clearErrors();
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("boom");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("auto-dismisses timed-out toasts", async () => {
    const setup = await createTestRenderer({ width: 40, height: 5 });
    try {
      const toasts = new ToastRegion(setup.renderer);
      setup.renderer.root.add(toasts);
      toasts.show("timed out", "info");
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("timed out");
    } finally {
      setup.renderer.destroy();
    }
  });
});