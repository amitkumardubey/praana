import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from "bun:test";
import { createNullScorecard } from "../src/context-engine/telemetry.js";
import { executeSlashCommand } from "../src/slash-commands.js";
import type { Session } from "../src/session.js";
import * as modelResolverActual from "../src/model-resolver.js";

// Snapshot real exports BEFORE mock.module updates live bindings
const mrReal = { ...modelResolverActual };

const mockResolveModelSpecifier = mock<typeof modelResolverActual.resolveModelSpecifier>();
const mockGetProviderConfigurationError = mock<typeof modelResolverActual.getProviderConfigurationError>(() => null);

mock.module("../src/model-resolver.js", () => ({
  ...mrReal,
  resolveModelSpecifier: mockResolveModelSpecifier,
  getProviderConfigurationError: mockGetProviderConfigurationError,
}));

import {
  resolveModelSpecifier,
  getProviderConfigurationError,
} from "../src/model-resolver.js";

function mockSessionLogger() {
  const info = mock();
  const warn = mock();
  const childLogger = { info, warn };
  return {
    getLogger: mock(() => ({
      child: mock(() => childLogger),
    })),
    info,
    warn,
  };
}

describe("executeSlashCommand", () => {
  beforeEach(() => {
    mockResolveModelSpecifier.mockReset();
    mockGetProviderConfigurationError.mockReset();
    mockGetProviderConfigurationError.mockReturnValue(null);
  });

  it("returns exit action for /exit", async () => {
    const session = {
      stateGraph: { list: () => [] },
    } as unknown as Session;

    const result = await executeSlashCommand("/exit", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(result.action).toBe("exit");
    expect(result.lines[0]).toContain("Ending session");
  });

  it("shows effective provider/model when /model has no args", async () => {
    const session = {
      getActiveModelLabel: mock(() => "openrouter/deepseek/deepseek-v4-flash:free"),
    } as unknown as Session;

    const result = await executeSlashCommand("/model", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(result.lines[0]).toBe("Current: openrouter/deepseek/deepseek-v4-flash:free");
  });

  it("returns refresh_status when model changes on same provider", async () => {
    const setModel = mock();
    const setProviderOverride = mock();
    const setModelOverride = mock();
    const append = mock();
    const { getLogger, info } = mockSessionLogger();

    (resolveModelSpecifier as ReturnType<typeof mock>).mockResolvedValue({
      provider: "openrouter",
      modelId: "gpt-4o",
      switchedProvider: false,
      source: "model-only",
      known: true,
    });

    const session = {
      getEffectiveProvider: () => "openrouter",
      getActiveModelLabel: mock(() => "openrouter/deepseek/deepseek-v4-flash:free"),
      setProviderOverride,
      setModelOverride,
      refreshModelContextWindow: mock(async () => 128_000),
      eventLog: { append },
      getLogger,
    } as unknown as Session;

    const result = await executeSlashCommand("/model gpt-4o", session, {
      setModel,
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(result.action).toBe("refresh_status");
    expect(result.toastTone).toBe("success");
    expect(setModel).toHaveBeenCalledWith("gpt-4o");
    expect(setModelOverride).toHaveBeenCalledWith("gpt-4o");
    expect(setProviderOverride).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          type: "model_switch",
          provider: "openrouter",
          model: "gpt-4o",
          userInput: "gpt-4o",
          outcome: "success",
        },
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          type: "model_override",
          provider: "openrouter",
          model: "gpt-4o",
        },
      }),
    );
    expect(info).toHaveBeenCalledWith("Model switch succeeded", {
      details: {
        provider: "openrouter",
        model: "gpt-4o",
        userInput: "gpt-4o",
        outcome: "success",
      },
    });
  });

  it("switches provider and logs provider_override when catalog resolves native provider", async () => {
    const setModel = mock();
    const setProviderOverride = mock();
    const setModelOverride = mock();
    const append = mock();
    const { getLogger } = mockSessionLogger();

    (resolveModelSpecifier as ReturnType<typeof mock>).mockResolvedValue({
      provider: "openai",
      modelId: "gpt-4o",
      switchedProvider: true,
      source: "native-catalog",
      known: true,
    });

    const session = {
      getEffectiveProvider: () => "openrouter",
      getActiveModelLabel: mock(() => "openrouter/gpt-4o"),
      setProviderOverride,
      setModelOverride,
      refreshModelContextWindow: mock(async () => 128_000),
      eventLog: { append },
      getLogger,
    } as unknown as Session;

    const result = await executeSlashCommand("/model openai gpt-4o", session, {
      setModel,
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(result.action).toBe("refresh_status");
    expect(result.toastTone).toBe("success");
    expect(setProviderOverride).toHaveBeenCalledWith("openai");
    expect(setModelOverride).toHaveBeenCalledWith("gpt-4o");
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          type: "model_switch",
          provider: "openai",
          model: "gpt-4o",
          userInput: "openai gpt-4o",
          outcome: "success",
        },
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { type: "provider_override", provider: "openai" },
      }),
    );
    // provider_override should be logged before model_override for correct replay order
    const providerOverrideIdx = append.mock.calls.findIndex(
      (c: any) => c[0]?.payload?.type === "provider_override",
    );
    const modelOverrideIdx = append.mock.calls.findIndex(
      (c: any) => c[0]?.payload?.type === "model_override",
    );
    expect(modelOverrideIdx).toBeGreaterThanOrEqual(0);
    expect(providerOverrideIdx).toBeGreaterThanOrEqual(0);
    expect(providerOverrideIdx).toBeLessThan(modelOverrideIdx);
  });

  it("shows error when target provider API key is missing", async () => {
    (resolveModelSpecifier as ReturnType<typeof mock>).mockResolvedValue({
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      switchedProvider: true,
      source: "native-catalog",
      known: true,
    });
    (getProviderConfigurationError as ReturnType<typeof mock>).mockReturnValue(
      "Missing required env var: ANTHROPIC_API_KEY",
    );

    const setProviderOverride = mock();
    const setModelOverride = mock();
    const append = mock();
    const { getLogger, warn } = mockSessionLogger();

    const session = {
      getEffectiveProvider: () => "openrouter",
      getActiveModelLabel: mock(() => "openrouter/gpt-4o"),
      setProviderOverride,
      setModelOverride,
      refreshModelContextWindow: mock(),
      eventLog: { append },
      getLogger,
    } as unknown as Session;

    const result = await executeSlashCommand(
      "/model anthropic claude-sonnet-4-20250514",
      session,
      {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => true,
      },
    );

    expect(result.action).toBe("none");
    expect(result.toastTone).toBe("error");
    expect(result.display).toBe("toast");
    expect(result.lines[0]).toContain("ANTHROPIC_API_KEY");
    expect(setProviderOverride).not.toHaveBeenCalled();
    expect(setModelOverride).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          type: "model_switch",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          userInput: "anthropic claude-sonnet-4-20250514",
          outcome: "failed",
          reason: "Missing required env var: ANTHROPIC_API_KEY",
        },
      }),
    );
    expect(warn).toHaveBeenCalledWith("Model switch failed", {
      details: {
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        userInput: "anthropic claude-sonnet-4-20250514",
        outcome: "failed",
        reason: "Missing required env var: ANTHROPIC_API_KEY",
      },
    });
  });

  it("rejects unknown model ids without switching or faking context window", async () => {
    (resolveModelSpecifier as ReturnType<typeof mock>).mockResolvedValue({
      provider: "openrouter",
      modelId: "totally/fake-model",
      switchedProvider: false,
      source: "provider-fallback",
      known: false,
    });

    const setModel = mock();
    const setModelOverride = mock();
    const refreshModelContextWindow = mock();
    const append = mock();
    const { getLogger, warn } = mockSessionLogger();

    const session = {
      getEffectiveProvider: () => "openrouter",
      getActiveModelLabel: mock(() => "openrouter/other-model"),
      setProviderOverride: mock(),
      setModelOverride,
      refreshModelContextWindow,
      eventLog: { append },
      getLogger,
    } as unknown as Session;

    const result = await executeSlashCommand("/model totally/fake-model", session, {
      setModel,
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(result.action).toBe("none");
    expect(result.lines[0]).toBe("Unknown model ID: totally/fake-model");
    expect(result.toastTone).toBe("error");
    expect(setModel).not.toHaveBeenCalled();
    expect(setModelOverride).not.toHaveBeenCalled();
    expect(refreshModelContextWindow).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          type: "model_switch",
          provider: "openrouter",
          model: "totally/fake-model",
          userInput: "totally/fake-model",
          outcome: "failed",
          reason: "unknown_model",
        },
      }),
    );
    expect(warn).toHaveBeenCalledWith("Model switch failed", {
      details: {
        provider: "openrouter",
        model: "totally/fake-model",
        userInput: "totally/fake-model",
        outcome: "failed",
        reason: "unknown_model",
      },
    });
  });

  it("shows info toast when already on the requested model", async () => {
    (resolveModelSpecifier as ReturnType<typeof mock>).mockResolvedValue({
      provider: "openrouter",
      modelId: "moonshotai/kimi-k2.7-code",
      switchedProvider: false,
      source: "provider-catalog",
      known: true,
    });

    const setModel = mock();
    const setModelOverride = mock();
    const append = mock();
    const { getLogger, info } = mockSessionLogger();

    const session = {
      getEffectiveProvider: () => "openrouter",
      getActiveModelLabel: mock(() => "openrouter/moonshotai/kimi-k2.7-code"),
      getContextWindowTokens: mock(() => 262_144),
      setProviderOverride: mock(),
      setModelOverride,
      refreshModelContextWindow: mock(),
      eventLog: { append },
      getLogger,
    } as unknown as Session;

    const result = await executeSlashCommand(
      "/model moonshotai/kimi-k2.7-code",
      session,
      {
        setModel,
        setThinking: mock(),
        getThinking: () => true,
      },
    );

    expect(result.action).toBe("none");
    expect(result.toastTone).toBe("info");
    expect(result.lines[0]).toBe("Already on: openrouter/moonshotai/kimi-k2.7-code (262,144 ctx)");
    expect(setModel).not.toHaveBeenCalled();
    expect(setModelOverride).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          type: "model_switch",
          provider: "openrouter",
          model: "moonshotai/kimi-k2.7-code",
          userInput: "moonshotai/kimi-k2.7-code",
          outcome: "already_on",
        },
      }),
    );
    expect(info).toHaveBeenCalledWith("Model switch skipped (already on target)", {
      details: {
        provider: "openrouter",
        model: "moonshotai/kimi-k2.7-code",
        userInput: "moonshotai/kimi-k2.7-code",
        outcome: "already_on",
      },
    });
  });

  it("shows error toast when model resolution throws", async () => {
    (resolveModelSpecifier as ReturnType<typeof mock>).mockRejectedValue(
      new Error("Provider catalog fetch timed out after 15000ms"),
    );

    const append = mock();
    const { getLogger, warn } = mockSessionLogger();

    const session = {
      getEffectiveProvider: () => "opencode",
      getActiveModelLabel: mock(() => "opencode/mimo-v2.5-free"),
      eventLog: { append },
      getLogger,
    } as unknown as Session;

    const result = await executeSlashCommand("/model mimo-v2.5-free", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(result.action).toBe("none");
    expect(result.toastTone).toBe("error");
    expect(result.lines[0]).toContain("Model lookup failed");
    expect(warn).toHaveBeenCalledWith("Model switch failed", {
      details: expect.objectContaining({
        outcome: "failed",
        reason: "Provider catalog fetch timed out after 15000ms",
      }),
    });
  });

  it("/stats includes weighted and raw context pressure in engine mode", async () => {
    const session = {
      id: "sess-stats",
      getStartedAt: () => Date.now() - 60_000,
      getUptimeMs: () => 60_000,
      getTurnCount: () => 3,
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getPersistentMemoryEntryCount: () => null,
      getMemoryDbPath: () => null,
      getMemoryStats: () => ({
        total: 1,
        active: 1,
        soft: 0,
        hard: 0,
        byKind: { task: 1 },
      }),
      scorecard: createNullScorecard(),
      isScorecardEnabled: () => false,
      getScorecardEngineOn: () => true,
      getRecallUsedCount: () => 0,
      memoryEnabled: false,
      isContextEngineEnabled: () => true,
      contextEngine: {
        finalizeTelemetry: () => ({
          artifactsProduced: 2,
          retrievalRate: 0.5,
          stats: {
            artifactRetrievals: 1,
            totalDistillerSavings: 100,
            pressureEvents: 1,
            compactionTriggers: 0,
          },
        }),
      },
      getLastCompileMetrics: () => ({
        totalTokens: 50_000,
        systemFrameTokens: 100,
        agentsContextTokens: 0,
        skillsCatalogTokens: 0,
        checkpointTokens: 0,
        crossSessionTokens: 0,
        activeStateTokens: 0,
        peripheralStubsTokens: 0,
        recentTurnsTokens: 0,
        currentInputTokens: 0,
        activeObjectCount: 0,
        peripheralObjectCount: 0,
        recentTurnsTruncated: false,
        memoryTruncated: false,
        agentsContextTruncated: false,
        skillsTruncated: false,
      }),
      getLastPressureRatio: () => 0.42,
      getLastWeightedTokens: () => 21_000,
      getLastRawPressureRatio: () => 0.5,
      getLastPressureMode: () => "emergency" as const,
      getContextWindowTokens: () => 100_000,
      config: {
        context_engine: { pressure: { compact_at: 0.7, emergency_at: 0.85 } },
      },
    } as unknown as Session;

    const result = await executeSlashCommand("/stats", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    const output = result.lines.join("\n");
    expect(output).toContain("Context pressure (last compile):");
    expect(output).toContain("Weighted fill: 21,000 tokens (42%)");
    expect(output).toContain("Raw fill: 50,000 / 100,000 tokens (50%)");
    expect(output).toContain("42% weighted · emergency (escalated)");
  });

  it("/scorecard prints scorecard lines when active", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { ScorecardTracker } = await import("../src/context-engine/telemetry.js");
    const { openContextEngineDb } = await import("../src/context-engine/db.js");

    const dbPath = join(mkdtempSync(join(tmpdir(), "praana-slash-scorecard-")), "context.db");
    const db = openContextEngineDb(dbPath);
    const scorecard = new ScorecardTracker(db, "sess-scorecard", false);
    scorecard.inc("totalTurns", 2);
    scorecard.inc("recallCalls", 3);

    const session = {
      id: "sess-scorecard",
      getTurnCount: () => 2,
      getStartedAt: () => Date.now(),
      getUptimeMs: () => 1000,
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getMemoryStats: () => ({ total: 0, active: 0, soft: 0, hard: 0, byKind: {} }),
      getPersistentMemoryEntryCount: () => 0,
      memoryEnabled: false,
      isContextEngineEnabled: () => false,
      isScorecardEnabled: () => true,
      getScorecardEngineOn: () => false,
      getRecallUsedCount: () => 1,
      scorecard,
      config: { session: { log_dir: "/tmp" }, context_engine: { pressure: {} } },
      cwd: "/tmp",
    } as unknown as Session;

    const result = await executeSlashCommand("/scorecard", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    db.close();
    rmSync(dbPath, { force: true });

    const output = result.lines.join("\n");
    expect(output).toContain("Scorecard (this session):");
    expect(output).toContain("recalls: 3");
    expect(output).toContain("measurement");
  });
});
// Restore real module after this file to prevent cross-test pollution
afterAll(() => {
  mock.module("../src/model-resolver.js", () => mrReal);
});
