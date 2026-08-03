/**
 * Tests for the OpenTUI model selector.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ModelSelector } from "../src/ui/tui/model-selector.js";

const mockModels = [
  { provider: "anthropic", modelId: "claude-4.6", label: "Claude 4.6", contextWindow: 200000, available: true },
  { provider: "anthropic", modelId: "claude-4.5", label: "Claude 4.5", contextWindow: 200000, available: true },
  { provider: "meta", modelId: "llama-3", label: "Llama 3", contextWindow: 8000, available: true },
];

describe("ModelSelector", () => {
  let selector: ModelSelector;
  let onSelectCalled: string | null;
  let onCancelCalled: boolean;

  beforeEach(async () => {
    onSelectCalled = null;
    onCancelCalled = false;
  });

  test("renders with a border and title", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new ModelSelector(setup.renderer, {
        currentProvider: "anthropic",
        currentModelId: "claude-4.6",
        loadModels: () => Promise.resolve(mockModels),
        onSelect: () => {},
        onCancel: () => { onCancelCalled = true; },
      });
      setup.renderer.root.add(ed);
      await setup.renderOnce();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("Search models");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("filters options as the user types", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new ModelSelector(setup.renderer, {
        currentProvider: "anthropic",
        currentModelId: "claude-4.6",
        loadModels: () => Promise.resolve(mockModels),
        onSelect: () => {},
        onCancel: () => {},
      });
      ed.start();
      setup.renderer.root.add(ed);
      await setup.renderOnce();
      await setup.flush();
      ed.focus();
      await setup.renderOnce();
      await setup.flush();
      await setup.mockInput.typeText("claude");
      await setup.renderOnce();
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("claude-4.6");
      expect(frame).toContain("claude-4.5");
      expect(frame).not.toContain("llama-3");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("emits selection on Enter", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new ModelSelector(setup.renderer, {
        currentProvider: "anthropic",
        currentModelId: "claude-4.6",
        loadModels: () => Promise.resolve(mockModels),
        onSelect: (provider, modelId) => {
          onSelectCalled = `${provider}/${modelId}`;
        },
        onCancel: () => {},
      });
      ed.start();
      setup.renderer.root.add(ed);
      await setup.renderOnce();
      await setup.flush();
      ed.focus();
      await setup.renderOnce();
      await setup.flush();
      await setup.mockInput.pressEnter();
      await setup.renderOnce();
      await setup.flush();
      expect(onSelectCalled).toBe("anthropic/claude-4.6");
    } finally {
      setup.renderer.destroy();
    }
  });

  test("calls onCancel when Escape is pressed", async () => {
    const setup = await createTestRenderer({ width: 60, height: 20 });
    try {
      const ed = new ModelSelector(setup.renderer, {
        currentProvider: "anthropic",
        currentModelId: "claude-4.6",
        loadModels: () => Promise.resolve(mockModels),
        onSelect: () => {},
        onCancel: () => { onCancelCalled = true; },
      });
      ed.start();
      setup.renderer.root.add(ed);
      await setup.renderOnce();
      await setup.flush();
      ed.focus();
      await setup.renderOnce();
      await setup.flush();
      setup.mockInput.pressEscape();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await setup.renderOnce();
      await setup.flush();
      expect(onCancelCalled).toBe(true);
    } finally {
      setup.renderer.destroy();
    }
  });
});
