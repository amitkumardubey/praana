import { describe, it, expect, beforeEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { BoxRenderable, TextRenderable } from "@opentui/core";
import { showOverlay, hideOverlay } from "../src/ui/tui/overlay.js";

describe("overlay helper", () => {
  it("centers a box over the root and removes it on hide", async () => {
    const setup = await createTestRenderer({ width: 40, height: 10 });
    try {
      const box = new BoxRenderable(setup.renderer, { id: "popup", width: 10, height: 3 });
      box.add(new TextRenderable(setup.renderer, { content: "POPUP" }));
      const handle = showOverlay(setup.renderer, box);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("POPUP");
      hideOverlay(setup.renderer, handle);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).not.toContain("POPUP");
    } finally {
      setup.renderer.destroy();
    }
  });
});