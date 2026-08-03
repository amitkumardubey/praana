/**
 * Tests for the OpenTUI login wizard.
 */
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { LoginWizard } from "../src/ui/tui/login-wizard.js";

const mockProviders = [
  { id: "anthropic", label: "Anthropic" },
  { id: "bedrock", label: "Amazon Bedrock" },
  {
    id: "openai",
    label: "OpenAI",
  },
];

describe("LoginWizard", () => {
  test("step 1 shows the provider list", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const wizard = new LoginWizard(setup.renderer, mockProviders, {
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

  test("selecting a provider advances to the auth method step", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const wizard = new LoginWizard(setup.renderer, mockProviders, {
        currentProvider: "anthropic",
        onComplete: () => {},
        onCancel: () => {},
      });
      setup.renderer.root.add(wizard);
      wizard.focus();
      await setup.renderOnce();
      await setup.flush();

      await setup.mockInput.pressEnter();
      await setup.renderOnce();
      await setup.flush();

      // Navigate down to "API key" option in auth-method step
      setup.mockInput.pressArrow("down");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await setup.renderOnce();
      await setup.flush();

      const frame = setup.captureCharFrame();
      expect(frame).toContain("API key");
    } finally {
      setup.renderer.destroy();
    }
  });
});
