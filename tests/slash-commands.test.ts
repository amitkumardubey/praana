import { describe, expect, it, vi, beforeEach } from "vitest";
import { executeSlashCommand } from "../src/slash-commands.js";
import type { Session } from "../src/session.js";

vi.mock("../src/model-resolver.js", () => ({
  resolveModelSpecifier: vi.fn(),
  getProviderConfigurationError: vi.fn(() => null),
}));

import {
  resolveModelSpecifier,
  getProviderConfigurationError,
} from "../src/model-resolver.js";

describe("executeSlashCommand", () => {
  beforeEach(() => {
    vi.mocked(resolveModelSpecifier).mockReset();
    vi.mocked(getProviderConfigurationError).mockReset();
    vi.mocked(getProviderConfigurationError).mockReturnValue(null);
  });

  it("returns exit action for /exit", async () => {
    const session = {
      stateGraph: { list: () => [] },
    } as unknown as Session;

    const result = await executeSlashCommand("/exit", session, {
      setModel: vi.fn(),
      setThinking: vi.fn(),
      getThinking: () => true,
    });

    expect(result.action).toBe("exit");
    expect(result.lines[0]).toContain("Ending session");
  });

  it("shows effective provider/model when /model has no args", async () => {
    const session = {
      getActiveModelLabel: vi.fn(() => "openrouter/deepseek/deepseek-v4-flash:free"),
    } as unknown as Session;

    const result = await executeSlashCommand("/model", session, {
      setModel: vi.fn(),
      setThinking: vi.fn(),
      getThinking: () => true,
    });

    expect(result.lines[0]).toBe("Current: openrouter/deepseek/deepseek-v4-flash:free");
  });

  it("returns refresh_status when model changes on same provider", async () => {
    const setModel = vi.fn();
    const setProviderOverride = vi.fn();
    const setModelOverride = vi.fn();
    const append = vi.fn();

    vi.mocked(resolveModelSpecifier).mockResolvedValue({
      provider: "openrouter",
      modelId: "gpt-4o",
      switchedProvider: false,
      source: "model-only",
      known: true,
    });

    const session = {
      getEffectiveProvider: () => "openrouter",
      getActiveModelLabel: vi.fn(() => "openrouter/gpt-4o"),
      setProviderOverride,
      setModelOverride,
      refreshModelContextWindow: vi.fn(async () => 128_000),
      eventLog: { append },
    } as unknown as Session;

    const result = await executeSlashCommand("/model gpt-4o", session, {
      setModel,
      setThinking: vi.fn(),
      getThinking: () => true,
    });

    expect(result.action).toBe("refresh_status");
    expect(setModel).toHaveBeenCalledWith("gpt-4o");
    expect(setModelOverride).toHaveBeenCalledWith("gpt-4o");
    expect(setProviderOverride).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { type: "model_override", model: "gpt-4o" },
      }),
    );
  });

  it("switches provider and logs provider_override when catalog resolves native provider", async () => {
    const setModel = vi.fn();
    const setProviderOverride = vi.fn();
    const setModelOverride = vi.fn();
    const append = vi.fn();

    vi.mocked(resolveModelSpecifier).mockResolvedValue({
      provider: "openai",
      modelId: "gpt-4o",
      switchedProvider: true,
      source: "native-catalog",
      known: true,
    });

    const session = {
      getEffectiveProvider: () => "openrouter",
      getActiveModelLabel: vi.fn(() => "openai/gpt-4o"),
      setProviderOverride,
      setModelOverride,
      refreshModelContextWindow: vi.fn(async () => 128_000),
      eventLog: { append },
    } as unknown as Session;

    const result = await executeSlashCommand("/model openai/gpt-4o", session, {
      setModel,
      setThinking: vi.fn(),
      getThinking: () => true,
    });

    expect(result.action).toBe("refresh_status");
    expect(setProviderOverride).toHaveBeenCalledWith("openai");
    expect(setModelOverride).toHaveBeenCalledWith("gpt-4o");
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { type: "provider_override", provider: "openai" },
      }),
    );
  });

  it("shows error when target provider API key is missing", async () => {
    vi.mocked(resolveModelSpecifier).mockResolvedValue({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      switchedProvider: true,
      source: "native-catalog",
      known: true,
    });
    vi.mocked(getProviderConfigurationError).mockReturnValue(
      "Missing required env var: ANTHROPIC_API_KEY",
    );

    const setProviderOverride = vi.fn();
    const setModelOverride = vi.fn();

    const session = {
      getEffectiveProvider: () => "openrouter",
      setProviderOverride,
      setModelOverride,
      refreshModelContextWindow: vi.fn(),
      eventLog: { append: vi.fn() },
    } as unknown as Session;

    const result = await executeSlashCommand(
      "/model anthropic/claude-sonnet-4-20250514",
      session,
      {
        setModel: vi.fn(),
        setThinking: vi.fn(),
        getThinking: () => true,
      },
    );

    expect(result.action).toBe("none");
    expect(result.lines[0]).toContain("ANTHROPIC_API_KEY");
    expect(setProviderOverride).not.toHaveBeenCalled();
    expect(setModelOverride).not.toHaveBeenCalled();
  });

  it("rejects unknown model ids without switching or faking context window", async () => {
    vi.mocked(resolveModelSpecifier).mockResolvedValue({
      provider: "openrouter",
      modelId: "totally/fake-model",
      switchedProvider: false,
      source: "openrouter-fallback",
      known: false,
    });

    const setModel = vi.fn();
    const setModelOverride = vi.fn();
    const refreshModelContextWindow = vi.fn();

    const session = {
      getEffectiveProvider: () => "openrouter",
      setProviderOverride: vi.fn(),
      setModelOverride,
      refreshModelContextWindow,
      eventLog: { append: vi.fn() },
    } as unknown as Session;

    const result = await executeSlashCommand("/model totally/fake-model", session, {
      setModel,
      setThinking: vi.fn(),
      getThinking: () => true,
    });

    expect(result.action).toBe("none");
    expect(result.lines[0]).toBe("Unknown model ID: totally/fake-model");
    expect(setModel).not.toHaveBeenCalled();
    expect(setModelOverride).not.toHaveBeenCalled();
    expect(refreshModelContextWindow).not.toHaveBeenCalled();
  });
});
