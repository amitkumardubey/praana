/**
 * Tests for the OpenTUI logout wizard.
 */
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { LogoutWizard } from "../src/ui/tui/logout-wizard.js";

const mockProviders = [
  { id: "anthropic", label: "Anthropic" },
  { id: "bedrock", label: "Amazon Bedrock" },
  { id: "openai", label: "OpenAI" },
];

describe("LogoutWizard", () => {
  test("lists authed providers", async () => {
    const setup = await createTestRenderer({ width: 50, height: 15 });
    try {
      const wizard = new LogoutWizard(setup.renderer, mockProviders, {
        currentProvider: "anthropic",
        onComplete: () => {},
        onCancel: () => {},
      });
      setup.renderer.root.add(wizard);
      wizard.focus();
      await setup.renderOnce();
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Anthropic");
      expect(frame).toContain("Amazon Bedrock");
      expect(frame).toContain("OpenAI");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("confirms logout on Enter", async () => {
    let result: { provider: string; message: string } | null = null;
    const setup = await createTestRenderer({ width: 50, height: 15 });
    try {
      const wizard = new LogoutWizard(setup.renderer, mockProviders, {
        currentProvider: "openai",
        onComplete: (r) => {
          result = { provider: r.provider, message: r.message };
        },
        onCancel: () => {},
      });
      setup.renderer.root.add(wizard);
      wizard.focus();
      await setup.renderOnce();
      await setup.flush();

      // First item is "anthropic" (index 0)
      setup.mockInput.pressEnter();
      await setup.renderOnce();
      await setup.flush();

      expect(result).not.toBeNull();
      expect(result!.provider).toBe("anthropic");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("calls onCancel when Escape is pressed", async () => {
    let cancelled = false;
    const setup = await createTestRenderer({ width: 50, height: 15 });
    try {
      const wizard = new LogoutWizard(setup.renderer, mockProviders, {
        currentProvider: "anthropic",
        onComplete: () => {},
        onCancel: () => {
          cancelled = true;
        },
      });
      setup.renderer.root.add(wizard);
      wizard.focus();
      await setup.renderOnce();
      await setup.flush();

      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await setup.renderOnce();
      await setup.flush();

      expect(cancelled).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });
});
