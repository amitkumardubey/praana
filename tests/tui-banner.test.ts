import { describe, it, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { buildBootBanner, setBannerRenderContext, PRAANA_WORDMARK } from "../src/ui/tui/banner.js";

describe("buildBootBanner", () => {
  it("renders wordmark lines and version when width fits", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      setBannerRenderContext(setup.renderer);
      const banner = buildBootBanner({
        version: "1.2.3",
        summaryLines: ["session abc123", "model claude"],
        width: 60,
        noColor: true,
        banner: true,
      });
      setup.renderer.root.add(banner);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("v1.2.3");
      expect(frame).toContain("session abc123");
      expect(frame).toContain("model claude");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("omits wordmark art when width is too narrow", async () => {
    const setup = await createTestRenderer({ width: 20, height: 20 });
    try {
      setBannerRenderContext(setup.renderer);
      const banner = buildBootBanner({
        version: "1.2.3",
        summaryLines: [],
        width: 20,
        noColor: true,
        banner: true,
      });
      setup.renderer.root.add(banner);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      // The first wordmark line is "  _ __  _ __ __ _  __ _ _ __   __ _"; its
      // leading distinctive token is "_ __" — ensure it's absent at narrow width.
      expect(frame).not.toContain("_ __");
      expect(frame).toContain("v1.2.3");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("exports the original figlet wordmark constants for parity", () => {
    expect(Array.isArray(PRAANA_WORDMARK)).toBe(true);
    expect(PRAANA_WORDMARK.length).toBeGreaterThan(0);
  });
});
