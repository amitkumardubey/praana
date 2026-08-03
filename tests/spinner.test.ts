import { describe, it, expect, beforeEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { Spinner } from "../src/ui/tui/spinner.js";

describe("Spinner", () => {
  it("renders label text alongside a spinner glyph", async () => {
    const setup = await createTestRenderer({ width: 30, height: 3 });
    try {
      const sp = new Spinner(setup.renderer, "thinking…");
      setup.renderer.root.add(sp);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("thinking…");
      sp.stop();
    } finally {
      setup.renderer.destroy();
    }
  });

  it("stop clears the animation interval", async () => {
    const setup = await createTestRenderer({ width: 30, height: 3 });
    try {
      const sp = new Spinner(setup.renderer, "loading…");
      setup.renderer.root.add(sp);
      await setup.renderOnce();
      expect(setup.captureCharFrame()).toContain("loading…");
      sp.stop();
    } finally {
      setup.renderer.destroy();
    }
  });
});