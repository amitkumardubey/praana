import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { z } from "zod";
import * as piAiActual from "@earendil-works/pi-ai/compat";
import * as llmActual from "../src/llm.js";
import * as toolsActual from "../src/tools/index.js";
import * as compileClassicActual from "../src/compile-classic.js";
import * as autoCompactActual from "../src/auto-compact.js";
import * as uiActual from "../src/ui.js";

const piAiReal = { ...piAiActual };
const llmReal = { ...llmActual };
const toolsReal = { ...toolsActual };
const compileClassicReal = { ...compileClassicActual };
const autoCompactReal = { ...autoCompactActual };
const uiReal = { ...uiActual };

mock.module("@earendil-works/pi-ai/compat", () => ({
  stream: mock(),
  clampThinkingLevel: mock((_model: unknown, level: string) => level),
  getSupportedThinkingLevels: mock(() => ["off", "low", "medium", "high"]),
}));

mock.module("../src/llm.js", () => ({
  createProvider: mock(() => mock(() => ({}))),
  resolveModel: mock((name: string) => name),
  inferReasoningModel: mock(() => false),
  getReasoningEffort: mock(() => undefined),
}));

mock.module("../src/tools/index.js", () => ({
  createAllTools: mock(() => ({
    shell: {
      description: "Execute a shell command",
      parameters: z.object({ command: z.string() }),
      execute: mock().mockResolvedValue({ ok: true, stdout: "hello" }),
    },
  })),
  describeTools: mock(() => ["shell(command) — Execute a shell command"]),
}));

mock.module("../src/compile-classic.js", () => ({
  compileClassicWithMetrics: mock(() => ({
    prompt: "classic compiled prompt",
    metrics: {
      totalTokens: 800,
      systemFrameTokens: 120,
      agentsContextTokens: 0,
      skillsCatalogTokens: 0,
      checkpointTokens: 0,
      crossSessionTokens: 0,
      activeStateTokens: 0,
      peripheralStubsTokens: 0,
      recentTurnsTokens: 500,
      currentInputTokens: 70,
      activeObjectCount: 0,
      peripheralObjectCount: 0,
      recentTurnsTruncated: false,
      memoryTruncated: false,
      agentsContextTruncated: false,
      skillsTruncated: false,
    },
  })),
}));

mock.module("../src/auto-compact.js", () => ({
  maybeAutoCompactClassic: mock(async () => ({
    compacted: false,
    eventsCompacted: 0,
    factsStored: 0,
    pressureRatio: 0,
  })),
  formatCompactionBanner: mock(() => null),
}));

mock.module("../src/ui.js", () => ({
  printDebug: mock(),
  printDebugBlock: mock(),
  printMemoryBanner: mock(),
  printToolCall: mock(),
  startSpinner: mock(),
  stopSpinner: mock(),
}));

import { stream as piStream, type Message } from "@earendil-works/pi-ai/compat";
import { runTurn, runLlmStream, isRecoverableStreamError } from "../src/turn.js";
import { StateGraph } from "../src/state-graph.js";
import { createNullScorecard } from "../src/context-engine/telemetry.js";
import type { Event } from "../src/types.js";

afterAll(() => {
  mock.module("@earendil-works/pi-ai/compat", () => piAiReal);
  mock.module("../src/llm.js", () => llmReal);
  mock.module("../src/tools/index.js", () => toolsReal);
  mock.module("../src/compile-classic.js", () => compileClassicReal);
  mock.module("../src/auto-compact.js", () => autoCompactReal);
  mock.module("../src/ui.js", () => uiReal);
});

const makeConfig = () => ({
  llm: {
    provider: "umans",
    model: "umans-coder",
  },
  context_engine: { enabled: false },
  compiler: {
    token_budget: 100_000,
    recent_turns: 10,
    recent_turns_token_budget: 30_000,
    recall_min_score: 0.35,
    memories_budget_ratio: 0.2,
    agents_budget_ratio: 0.3,
    reserved_output_tokens: 0,
    auto_compact_at: 0.75,
    auto_compact_clear_at: 0.55,
    compact_chunk_fraction: 0.25,
    verbatim_only: false,
    compression_watermark: 0.75,
    compression_flush_fraction: 0.30,
  },
  session: { log_dir: "/tmp/praana-test-sessions" },
  turn: { max_steps: 25 },
  tools: { block_repeat_reads: false },
  skills: {
    enabled: false,
    max_token_budget_ratio: 0.2,
    max_loaded_skills: 3,
    stale_threshold_turns: 10,
    max_depth: 6,
  },
});

function makeMockSession(overrides?: Partial<Record<string, any>>) {
  const config = makeConfig();
  const stateGraph = new StateGraph();

  const events: Event[] = [];
  const eventLog = {
    append: mock((ev: Omit<Event, "event_id" | "session_id" | "timestamp">) => {
      const event: Event = {
        event_id: `evt-${events.length}`,
        session_id: "test-session",
        timestamp: Date.now(),
        ...ev,
      } as Event;
      events.push(event);
    }),
    readLast: mock((n: number) => events.slice(-n)),
    readLastUncompressed: mock((n: number) => events.slice(-n)),
    readLastUncompressedAfterResetBoundary: mock((n: number) => events.slice(-n)),
    readAll: mock(() => events.slice()),
    readAllUncompressed: mock(() => events.slice()),
    readAllUncompressedAfterResetBoundary: mock(() => events.slice()),
    search: mock(),
    clear: mock(() => { events.length = 0; }),
  };

  const session: any = {
    id: `test-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    cwd: "/home/test/project",
    config,
    eventLog,
    stateGraph,
    memoryStore: null,
    memoryEnabled: false,
    incognito: false,
    contextEngine: null,
    scorecard: createNullScorecard(),
    digest: null,
    agentsContext: null,
    debug: false,
    promptDir: "/tmp/praana-test/prompts",
    _turnCount: 0,
    _lastCompileMetrics: null,
    _providerOverride: null as string | null,
    _modelOverride: null as string | null,

    incrementTurn() {
      this._turnCount++;
      this.stateGraph.incrementTurn();
    },
    persistStateGraphCheckpoint: mock(),
    getTurnCount() { return this._turnCount; },
    getLastResetBoundaryTurn() { return -1; },
    getVisibleSessionCheckpoint() { return undefined; },
    getMemoryStats() {
      return {
        total: this.stateGraph.snapshot().length,
        active: this.stateGraph.getActive().length,
        soft: this.stateGraph.getPeripheral().filter((o: any) => o.tier === "soft").length,
        hard: this.stateGraph.getPeripheral().filter((o: any) => o.tier === "hard").length,
        byKind: {} as Record<string, number>,
      };
    },
    setLastCompileMetrics(m: any) { this._lastCompileMetrics = m; },
    getLastCompileMetrics() { return this._lastCompileMetrics; },
    setLastCompileScoreRecords() {},
    getLastCompileScoreRecords() { return []; },
    getCompileScoreRecord() { return undefined; },
    getLastPressureMode() { return "normal"; },
    getLastPressureRatio() { return 0; },
    getLastWeightedTokens() { return this._lastCompileMetrics?.totalTokens ?? 0; },
    getLastRawPressureRatio() { return 0; },
    _displayContextSnapshot: null,
    getDisplayContextSnapshot() { return this._displayContextSnapshot; },
    setDisplayContextSnapshot(s: any) { this._displayContextSnapshot = s; },
    setLastKnownTaskType() {},
    setLastUserInput() {},
    getLastUserInput() { return ""; },
    isIncognito() { return false; },
    isPlanMode() { return false; },
    enterPlanMode() {},
    exitPlanMode() {},
    isContextEngineEnabled() { return false; },
    skills: [],
    _inputTokens: 0,
    _outputTokens: 0,
    recordInputTokens(count: number) { this._inputTokens += count; },
    recordOutputTokens(count: number) { this._outputTokens += count; },
    getInputTokens() { return this._inputTokens; },
    getOutputTokens() { return this._outputTokens; },
    ensureModelContextWindow: mock(async () => 128_000),
    getContextWindowTokens: mock(() => 128_000),
    getEffectiveProvider() {
      return this._providerOverride ?? this.config.llm.provider;
    },
    getEffectiveLlmConfig() {
      return { ...this.config.llm, provider: this.getEffectiveProvider() };
    },
    getActiveModelId() {
      return this._modelOverride ?? this.config.llm.model;
    },
    getActiveModelLabel() {
      return `${this.getEffectiveProvider()}/${this.getActiveModelId()}`;
    },
    getProviderOverride() {
      return this._providerOverride;
    },
    setProviderOverride(provider: string | null) {
      this._providerOverride = provider;
    },
    getModelOverride() {
      return this._modelOverride;
    },
    setModelOverride(model: string | null) {
      this._modelOverride = model;
    },
    isCompactionArmed: mock(() => false),
    setCompactionArmed: mock(),
    ...overrides,
  };

  return session;
}

describe("runLlmStream", () => {
  beforeEach(() => {
    (piStream as any).mockReset();
  });

  it("returns success on first stream attempt", async () => {
    const stream = async function* () {
      yield { type: "text_delta", delta: "hello" };
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } };
    };
    (piStream as any).mockReturnValue(stream() as any);

    const result = await runLlmStream({
      model: { id: "m" } as any,
      modelName: "m",
      providerName: "p",
      compiledPrompt: "sys",
      history: [{ role: "user", content: "hi" } as Message],
      piTools: [],
    });

    expect(result.finalReason).toBe("stop");
    expect(result.fullResponse).toBe("hello");
    expect(result.pendingToolCalls).toHaveLength(0);
  });

  it("collects pending tool calls", async () => {
    const stream = async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "tc1", name: "read_file", arguments: { path: "/tmp/a.txt" } },
      };
      yield { type: "done", reason: "toolUse", message: { role: "assistant", content: [] } };
    };
    (piStream as any).mockReturnValue(stream() as any);

    const result = await runLlmStream({
      model: { id: "m" } as any,
      modelName: "m",
      providerName: "p",
      compiledPrompt: "sys",
      history: [{ role: "user", content: "hi" } as Message],
      piTools: [{ name: "read_file", description: "read", parameters: { type: "object" } }],
    });

    expect(result.finalReason).toBe("toolUse");
    expect(result.pendingToolCalls).toHaveLength(1);
    expect(result.pendingToolCalls[0].toolName).toBe("read_file");
  });
});

describe("LLM fallback", () => {
  beforeEach(() => {
    (piStream as any).mockReset();
  });

  afterEach(() => {
    (piStream as any).mockReset();
  });

  it("falls back to configured provider/model after rate limit error", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "moonshotai/kimi-k2.7-code";

    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return (async function* () {
          yield { type: "error", reason: "rate_limit", error: { role: "assistant", errorMessage: "429 rate limit" } };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "fallback ok" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "fallback ok" }] } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("fallback ok");
    expect(session.getEffectiveProvider()).toBe("openrouter");
    expect(session.getActiveModelId()).toBe("moonshotai/kimi-k2.7-code");
    expect(callCount).toBe(3);
  });

  it("falls back on timeout reason", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";

    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return (async function* () {
          yield { type: "error", reason: "timeout", error: { role: "assistant", errorMessage: "request timed out" } };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "timeout fallback ok" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "timeout fallback ok" }] } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("timeout fallback ok");
    expect(session.getEffectiveProvider()).toBe("openrouter");
  });

  it("falls back on empty response", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";

    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return (async function* () {
          yield { type: "done", reason: "stop", message: { role: "assistant", content: [] } };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "empty fallback ok" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "empty fallback ok" }] } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("empty fallback ok");
    expect(session.getEffectiveProvider()).toBe("openrouter");
  });

  it("does not fall back without fallback config", async () => {
    const session = makeMockSession();

    (piStream as any).mockImplementation(() => {
      return (async function* () {
        yield { type: "error", reason: "rate_limit", error: { role: "assistant", errorMessage: "429" } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("no response from model");
    expect(session.getEffectiveProvider()).toBe("umans");
  });

  it("records provider_override and model_override events on successful fallback", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";

    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return (async function* () {
          yield { type: "error", reason: "rate_limit", error: { role: "assistant", errorMessage: "429" } };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "fallback ok" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "fallback ok" }] } };
      })();
    });

    await runTurn(session, "hello");

    const overrides = session.eventLog.readAll().filter(
      (e: any) =>
        e.kind === "system_note" &&
        (e.payload.type === "provider_override" || e.payload.type === "model_override"),
    );
    expect(overrides.length).toBe(2);
    expect(overrides[0].payload.reason).toBe("llm_fallback");
    expect(overrides[1].payload.reason).toBe("llm_fallback");
  });

  it("does not commit override events when fallback also fails", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";

    (piStream as any).mockImplementation(() => {
      return (async function* () {
        yield { type: "error", reason: "rate_limit", error: { role: "assistant", errorMessage: "429 exhausted" } };
      })();
    });

    await runTurn(session, "hello");

    const overrides = session.eventLog.readAll().filter(
      (e: any) =>
        e.kind === "system_note" &&
        (e.payload.type === "provider_override" || e.payload.type === "model_override"),
    );
    expect(overrides.length).toBe(0);
    expect(session.getEffectiveProvider()).toBe("umans");
    expect(session.getActiveModelId()).toBe("umans-coder");
  });

  it("surfaces an error message when fallback is also exhausted", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";

    (piStream as any).mockImplementation(() => {
      return (async function* () {
        yield { type: "error", reason: "rate_limit", error: { role: "assistant", errorMessage: "429 exhausted" } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("I encountered an error");
    expect(session.getEffectiveProvider()).toBe("umans");
    expect(session.getActiveModelId()).toBe("umans-coder");
  });

  it("retries once on same model before falling back", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";

    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return (async function* () {
          yield { type: "error", reason: "rate_limit", error: { role: "assistant", errorMessage: "429" } };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "retry ok" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "retry ok" }] } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("retry ok");
    expect(session.getEffectiveProvider()).toBe("umans");
    expect(callCount).toBe(2);
  });

  it("does not overwrite an explicit user /model override", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    session.setProviderOverride("anthropic");
    session.setModelOverride("claude-sonnet-4");

    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount++;
      if (callCount <= 2) {
        return (async function* () {
          yield { type: "error", reason: "rate_limit", error: { role: "assistant", errorMessage: "429" } };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "fallback ok" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "fallback ok" }] } };
      })();
    });

    const response = await runTurn(session, "hello", "claude-sonnet-4");
    expect(response).not.toContain("fallback ok");
    expect(response).toContain("no response from model");
    expect(session.getEffectiveProvider()).toBe("anthropic");
    expect(session.getActiveModelId()).toBe("claude-sonnet-4");
    expect(callCount).toBe(2);

    const overrides = session.eventLog.readAll().filter(
      (e: any) =>
        e.kind === "system_note" &&
        (e.payload.type === "provider_override" || e.payload.type === "model_override"),
    );
    expect(overrides.length).toBe(0);
  });

  it("matches 'Rate Limited' and 'Too Many Requests' error messages", () => {
    const rateLimited: any = { interrupted: false, finalReason: "error", errorMessage: "Rate Limited", fullResponse: "", pendingToolCalls: [] };
    expect(isRecoverableStreamError(rateLimited)).toBe(true);
    const tooMany: any = { interrupted: false, finalReason: "error", errorMessage: "Too Many Requests", fullResponse: "", pendingToolCalls: [] };
    expect(isRecoverableStreamError(tooMany)).toBe(true);
  });
});
