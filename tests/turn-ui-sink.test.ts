import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  stream: vi.fn(),
}));

vi.mock("../src/compiler.js", () => ({
  compileWithMetrics: vi.fn(() => ({
    prompt: "compiled",
    metrics: {
      totalTokens: 100,
      systemFrameTokens: 10,
      agentsContextTokens: 0,
      skillsCatalogTokens: 0,
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

vi.mock("../src/tools/index.js", () => ({
  createAllTools: vi.fn(() => ({})),
  describeTools: vi.fn(() => []),
}));

vi.mock("../src/llm.js", () => ({
  createProvider: vi.fn(() => vi.fn(() => ({}))),
  resolveModel: vi.fn((name: string) => name),
}));

import { stream as piStream } from "@earendil-works/pi-ai";
import { runTurn } from "../src/turn.js";
import type { Session } from "../src/session.js";

function mockSession(): Session {
  return {
    eventLog: {
      append: vi.fn(),
      readLast: vi.fn(() => []),
      readLastUncompressed: vi.fn(() => []),
      markEventsAsCompressed: vi.fn(),
    },
    stateGraph: {
      autoHydrate: vi.fn(() => []),
      get: vi.fn(),
      getTurnCount: vi.fn(() => 0),
      getActive: vi.fn(() => []),
      getPeripheral: vi.fn(() => []),
      getTouchedTurn: vi.fn(() => 0),
      setTier: vi.fn(),
      list: vi.fn(() => []),
    },
    config: {
      llm: { model: "test/model" },
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
    isIncognito: vi.fn(() => false),
    skillRuntime: {
      setBudgetBase: vi.fn(),
      processUserInput: vi.fn(),
      buildPromptSection: vi.fn(() => null),
      endTurn: vi.fn(),
      drainEvents: vi.fn(() => []),
    },
    agentsContext: null,
    promptDir: "/tmp",
    setLastCompileMetrics: vi.fn(),
    recordInputTokens: vi.fn(),
    recordOutputTokens: vi.fn(),
    incrementTurn: vi.fn(),
    getMemoryStats: vi.fn(() => ({
      total: 0,
      active: 0,
      soft: 0,
      hard: 0,
      byKind: {},
    })),
  } as unknown as Session;
}

describe("runTurn with UI sink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("routes text deltas through sink instead of stdout", async () => {
    const stdoutWrite = vi.mocked(process.stdout.write);
    stdoutWrite.mockClear();

    async function* mockStream() {
      yield { type: "text_delta", delta: "Hello" };
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      };
    }
    vi.mocked(piStream).mockReturnValue(mockStream() as any);

    const onTextDelta = vi.fn();
    const onMemoryBanner = vi.fn();
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
