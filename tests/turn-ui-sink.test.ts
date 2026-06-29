import { describe, it, expect, beforeEach, afterAll, mock, spyOn } from "bun:test";
import * as compileClassicActual from "../src/compile-classic.js";
import * as llmActual from "../src/llm.js";
import * as toolsActual from "../src/tools/index.js";
import * as piAiActual from "@earendil-works/pi-ai";
import { createNullScorecard } from "../src/context-engine/telemetry.js";

// Snapshot real exports BEFORE mock.module updates live bindings
const ccReal = { ...compileClassicActual };
const llmReal = { ...llmActual };
const toolsReal = { ...toolsActual };
const piAiReal = { ...piAiActual };

mock.module("@earendil-works/pi-ai", () => ({
  stream: mock(),
}));

mock.module("../src/compiler.js", () => ({}));

mock.module("../src/compile-classic.js", () => ({
  compileClassicWithMetrics: mock(() => ({
    prompt: "classic compiled",
    metrics: {
      totalTokens: 100,
      systemFrameTokens: 10,
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
    },
  })),
}));

mock.module("../src/tools/index.js", () => ({
  createAllTools: mock(() => ({})),
  describeTools: mock(() => []),
}));

mock.module("../src/llm.js", () => ({
  createProvider: mock(() => mock(() => ({}))),
  resolveModel: mock((name: string) => name),
  inferReasoningModel: mock(() => false),
  getReasoningEffort: mock(() => undefined),
}));

import { stream as piStream } from "@earendil-works/pi-ai";
import { runTurn } from "../src/turn.js";
import type { Session } from "../src/session.js";

function mockSession(): Session {
  return {
    eventLog: {
      append: mock(),
      readLast: mock(() => []),
      readLastUncompressed: mock(() => []),
      readAll: mock(() => []),
      readAllUncompressed: mock(() => []),
      markEventsAsCompressed: mock(),
    },
    stateGraph: {
      autoHydrate: mock(() => []),
      get: mock(),
      getTurnCount: mock(() => 0),
      getActive: mock(() => []),
      getPeripheral: mock(() => []),
      getTouchedTurn: mock(() => 0),
      setTier: mock(),
      list: mock(() => []),
    },
    config: {
      llm: { provider: "openrouter", model: "test/model" },
      compiler: {
        token_budget: 100_000,
        recent_turns: 10,
        recent_turns_token_budget: 30_000,
        compression_watermark: 0.75,
        compression_flush_fraction: 0.3,
      },
      tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
      skills: { max_token_budget_ratio: 0.2 },
    },
    cwd: "/tmp",
    id: "test",
    debug: false,
    digest: null,
    memoryEnabled: false,
    memoryStore: null,
    contextEngine: null,
    scorecard: createNullScorecard(),
    isIncognito: mock(() => false),
    isContextEngineEnabled: mock(() => false),
    getTurnCount: mock(() => 0),
    skillRuntime: {
      cleanupStaleSkills: mock(),
      drainEvents: mock(() => []),
      trackLoad: mock(),
      getLoadedSkillNames: mock(() => []),
    },
    agentsContext: null,
    skills: [],
    promptDir: "/tmp",
    setLastCompileMetrics: mock(),
    setLastCompileScoreRecords(_records?: unknown, _mode?: unknown, _ratio?: unknown) {},
    setLastUserInput: mock(),
    getLastUserInput: mock(() => ""),
    isCompactionArmed: mock(() => false),
    setCompactionArmed: mock(),
    recordInputTokens: mock(),
    recordOutputTokens: mock(),
    incrementTurn: mock(),
    persistStateGraphCheckpoint: mock(),
    getMemoryStats: mock(() => ({
      total: 0,
      active: 0,
      soft: 0,
      hard: 0,
      byKind: {},
    })),
    ensureModelContextWindow: mock(async () => 128_000),
    getContextWindowTokens: mock(() => 128_000),
    getEffectiveProvider: mock(() => "openrouter"),
    getEffectiveLlmConfig: mock(function (this: { config: { llm: unknown } }) {
      return this.config.llm;
    }),
    getActiveModelId: mock(() => "test/model"),
    getActiveModelLabel: mock(() => "openrouter/test/model"),
  } as unknown as Session;
}

describe("runTurn with UI sink", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("routes text deltas through sink instead of stdout", async () => {
    const stdoutWrite = (process.stdout.write as ReturnType<typeof mock>);
    stdoutWrite.mockClear();

    async function* mockStream() {
      yield { type: "text_delta", delta: "Hello" };
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      };
    }
    (piStream as ReturnType<typeof mock>).mockReturnValue(mockStream() as any);

    const onTextDelta = mock();
    const onMemoryBanner = mock();
    const session = mockSession();

    await runTurn(session, "hi", undefined, {
      sink: { onTextDelta, onMemoryBanner },
      onTextDelta,
    });

    expect(onTextDelta).toHaveBeenCalledWith("Hello");
    const stdoutTextCalls = stdoutWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("Hello")
    );
    expect(stdoutTextCalls).toHaveLength(0);
  });
});
// Restore real modules after this file to prevent cross-test pollution
afterAll(() => {
  mock.module("../src/compile-classic.js", () => ccReal);
  mock.module("../src/llm.js", () => llmReal);
  mock.module("../src/tools/index.js", () => toolsReal);
  mock.module("@earendil-works/pi-ai", () => piAiReal);
  mock.module("../src/compiler.js", () => ({}));
});
