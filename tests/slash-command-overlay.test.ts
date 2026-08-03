import { describe, it, expect, beforeEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { showSlashCommandResult } from "../src/ui/tui/slash-command-overlay.js";

describe("slash-command-overlay", () => {
  it("shows each result line inside a bordered box", async () => {
    const setup = await createTestRenderer({ width: 50, height: 15 });
    try {
      showSlashCommandResult(setup.renderer, ["Model set to claude-4.6", "Provider: bedrock"]);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Model set to claude-4.6");
      expect(frame).toContain("Provider: bedrock");
    } finally {
      setup.renderer.destroy();
    }
  });
});