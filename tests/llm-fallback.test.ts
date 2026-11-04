import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import * as nativeLlmActual from "../src/llm/index.js";
import * as llmActual from "../src/llm.js";
import * as toolsActual from "../src/tools/index.js";
import * as compileClassicActual from "../src/compile-classic.js";
import * as autoCompactActual from "../src/auto-compact.js";
import * as uiActual from "../src/ui.js";

const nativeLlmReal = { ...nativeLlmActual };
const llmReal = { ...llmActual };
const toolsReal = { ...toolsActual };
const compileClassicReal = { ...compileClassicActual };
const autoCompactReal = { ...autoCompactActual };
const uiReal = { ...uiActual };

const mockStream = mock();

mock.module("../src/llm/index.js", () => ({
  ...nativeLlmActual,
  streamLlmResponse: mockStream,
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

const piStream = mockStream;
import { runTurn, runLlmStream, isRecoverableStreamError } from "../src/turn.js";
import { StateGraph } from "../src/state-graph.js";
import { estimateAssistantMessageTokens } from "../src/context-display.js";
import { createNullScorecard } from "../src/context-engine/telemetry.js";
import { createBuiltinHookRegistry } from "../src/hooks/index.js";
import type { Event } from "../src/types.js";

afterAll(() => {
  mock.module("../src/llm/index.js", () => nativeLlmReal);
  mock.module("../src/llm.js", () => llmReal);
  mock.module("../src/tools/index.js", () => toolsReal);
  mock.module("../src/compile-classic.js", () => compileClassicReal);
  mock.module("../src/auto-compact.js", () => autoCompactReal);
  mock.module("../src/ui.js", () => uiReal);
});

const fallbackLogDir = mkdtempSync(join(tmpdir(), "praana-test-sessions-fallback-"));

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
  session: { log_dir: fallbackLogDir },
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
    hooks: createBuiltinHookRegistry("/home/test/project"),
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
    getEffectiveReasoningEffort() {
      return this.config.llm.reasoning_effort ?? "medium";
    },
    recordReasoningEffortUsed() {},
    getLastReasoningEffortUsed() {
      return null;
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

  it("does not treat a bare 429 or 529 in free text as a rate limit", () => {
    const tokens: any = { interrupted: false, finalReason: "error", errorMessage: "used 529 tokens", fullResponse: "", pendingToolCalls: [] };
    const requestId: any = { interrupted: false, finalReason: "error", errorMessage: "request id 429", fullResponse: "", pendingToolCalls: [] };
    expect(isRecoverableStreamError(tokens)).toBe(false);
    expect(isRecoverableStreamError(requestId)).toBe(false);
    const http: any = { interrupted: false, finalReason: "error", errorMessage: "HTTP 529", fullResponse: "", pendingToolCalls: [] };
    const status: any = { interrupted: false, finalReason: "error", errorMessage: "status 429", fullResponse: "", pendingToolCalls: [] };
    expect(isRecoverableStreamError(http)).toBe(true);
    expect(isRecoverableStreamError(status)).toBe(true);
    const structured: any = { interrupted: false, finalReason: "error", errorMessage: "used 529 tokens", status: 429, fullResponse: "", pendingToolCalls: [] };
    expect(isRecoverableStreamError(structured)).toBe(true);
  });

  it("retries a mid-stream overload once the provider status is visible", async () => {
    const session = makeMockSession();
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return (async function* () {
          yield {
            type: "error",
            error: new Error("Resource exhausted"),
            status: 429,
            retryable: false,
          };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "retried" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "retried" } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("retried");
    expect(callCount).toBe(2);
  });

  function emptyStop() {
    return (async function* () {
      yield { type: "done", reason: "stop", message: { role: "assistant", content: "" } };
    })();
  }

  it("does not commit a fallback that ended in a non-recoverable error", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    const lines: string[] = [];
    let call = 0;
    (piStream as any).mockImplementation(() => {
      call += 1;
      if (call <= 2) return emptyStop();
      return (async function* () {
        yield { type: "error", error: new Error("model exploded"), retryable: false };
      })();
    });

    await runTurn(session, "hello", undefined, {
      sink: { onSystemLines: (rows) => lines.push(...rows) },
    });

    expect(session.getEffectiveProvider()).toBe("umans");
    expect(session.getActiveModelId()).toBe("umans-coder");
    expect(lines.some((line) => line.startsWith("Switched to"))).toBe(false);
    const overrides = session.eventLog.readAll().filter(
      (event: { kind?: string }) => event.kind === "system_note",
    );
    expect(overrides).toEqual([]);
  });

  it("does not commit a fallback that aborted or ended on length", async () => {
    for (const terminal of ["abort", "length"] as const) {
      const session = makeMockSession();
      session.config.llm.fallback_provider = "openrouter";
      session.config.llm.fallback_model = "fallback-model";
      let call = 0;
      (piStream as any).mockImplementation(() => {
        call += 1;
        if (call <= 2) return emptyStop();
        return (async function* () {
          yield {
            type: "done",
            reason: terminal,
            message: {
              role: "assistant",
              content: terminal === "length" ? "cut" : "",
              toolCalls: terminal === "length"
                ? [{ id: "call_cut", name: "shell", args: { command: "echo" } }]
                : [],
            },
          };
        })();
      });
      await runTurn(session, "hello");
      expect(session.getEffectiveProvider(), terminal).toBe("umans");
    }
  });

  it("does not commit a fallback whose error kind is set", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    let call = 0;
    (piStream as any).mockImplementation(() => {
      call += 1;
      if (call <= 2) return emptyStop();
      return (async function* () {
        yield {
          type: "error",
          error: new Error("stream ended before the provider sent a final event (finish_reason or [DONE])"),
          retryable: false,
          kind: "premature_end",
        };
      })();
    });
    await runTurn(session, "hello");
    expect(session.getEffectiveProvider()).toBe("umans");
  });

  it("records an idle timeout as the fallback reason, not an empty response", async () => {
    const session = makeMockSession();
    session.config.llm.stream_idle_timeout_ms = 5_000;
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    const lines: string[] = [];
    let call = 0;
    (piStream as any).mockImplementation(() => {
      call += 1;
      if (call <= 2) {
        return (async function* () {
          yield { type: "done", reason: "timeout", message: { role: "assistant", content: "" } };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "fallback ok" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "fallback ok" } };
      })();
    });

    await runTurn(session, "hello", undefined, {
      sink: { onSystemLines: (rows) => lines.push(...rows) },
    });

    expect(session.getEffectiveProvider()).toBe("openrouter");
    expect(lines).toContain(
      "Switched to openrouter/fallback-model after The model stopped responding (idle timeout after 5s).",
    );
    expect(lines.some((line) => line.includes("empty response"))).toBe(false);
  });

  it("still records empty response when a clean fallback follows an empty stop", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    const lines: string[] = [];
    let call = 0;
    (piStream as any).mockImplementation(() => {
      call += 1;
      if (call <= 2) return emptyStop();
      return (async function* () {
        yield { type: "text_delta", delta: "fallback ok" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "fallback ok" } };
      })();
    });
    await runTurn(session, "hello", undefined, {
      sink: { onSystemLines: (rows) => lines.push(...rows) },
    });
    expect(lines).toContain("Switched to openrouter/fallback-model after empty response");
  });
});

const IDLE_TIMEOUT_ERROR =
  "The model stopped responding (idle timeout after 5s). The partial answer above was not completed.";
const IDLE_TIMEOUT_BARE = "The model stopped responding (idle timeout after 5s).";

function unpairedToolIds(messages: unknown): string[] {
  if (!Array.isArray(messages)) return ["invalid-history"];
  const pending: string[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const record = message as { role?: string; toolCalls?: Array<{ id?: string }>; toolCallId?: string };
    if (record.role === "assistant" && Array.isArray(record.toolCalls)) {
      for (const call of record.toolCalls) {
        if (call?.id) pending.push(call.id);
      }
    } else if (record.role === "tool_result" && record.toolCallId) {
      const index = pending.indexOf(record.toolCallId);
      if (index >= 0) pending.splice(index, 1);
    }
  }
  return pending;
}

function timeoutMidToolCall(text: string) {
  return (async function* () {
    yield { type: "tool_call_start", id: "call_partial", name: "shell" };
    yield { type: "tool_call_delta", id: "call_partial", argsDelta: '{"command":"ech' };
    yield {
      type: "done",
      reason: "timeout",
      message: {
        role: "assistant",
        content: text,
        toolCalls: [{ id: "call_partial", name: "shell", args: { command: "ech" } }],
      },
    };
  })();
}

function completedToolCall(id: string) {
  return (async function* () {
    yield {
      type: "toolcall_end",
      toolCall: { id, name: "shell", arguments: { command: "echo hi" } },
    };
    yield {
      type: "done",
      reason: "toolUse",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id, name: "shell", args: { command: "echo hi" } }],
      },
    };
  })();
}

describe("timeout history", () => {
  beforeEach(() => {
    (piStream as any).mockReset();
  });

  it("keeps the step-0 retry history valid after a mid-tool-call idle timeout", async () => {
    const session = makeMockSession();
    session.config.llm.stream_idle_timeout_ms = 5_000;
    const histories: unknown[] = [];
    const errors: string[] = [];
    (piStream as any).mockImplementation((req: { messages: unknown }) => {
      histories.push(req.messages);
      return timeoutMidToolCall("");
    });

    await runTurn(session, "hello", undefined, {
      sink: { onError: (entry) => errors.push(entry.message) },
    });

    expect(histories.length).toBeGreaterThan(1);
    expect(histories.every((messages) => unpairedToolIds(messages).length === 0)).toBe(true);
    expect(JSON.stringify(histories)).not.toContain("call_partial");
    expect(errors).toContain(IDLE_TIMEOUT_BARE);
    expect(errors.some((message) => message.includes("partial answer"))).toBe(false);
  });

  it("keeps history valid when a later tool step times out mid-tool-call", async () => {
    const session = makeMockSession();
    session.config.llm.stream_idle_timeout_ms = 5_000;
    const histories: unknown[] = [];
    const errors: string[] = [];
    const texts: string[] = [];
    let call = 0;
    (piStream as any).mockImplementation((req: { messages: unknown }) => {
      call += 1;
      histories.push(req.messages);
      if (call <= 2) return completedToolCall(`tool_${call}`);
      return (async function* () {
        yield { type: "text_delta", delta: "Partial answer" };
        yield* timeoutMidToolCall("Partial answer");
      })();
    });

    const response = await runTurn(session, "hello", undefined, {
      sink: {
        onError: (entry) => errors.push(entry.message),
        onTextDelta: (delta) => texts.push(delta),
      },
    });

    expect(call).toBe(3);
    expect(histories.every((messages) => unpairedToolIds(messages).length === 0)).toBe(true);
    expect(JSON.stringify(histories)).not.toContain("call_partial");
    expect(texts).toEqual(["Partial answer"]);
    expect(response).toContain("Partial answer");
    expect(errors).toContain(IDLE_TIMEOUT_ERROR);
  });

  it("counts only the retained assistant text after a timeout", async () => {
    const session = makeMockSession();
    const deltas: Array<{ tokensAdded: number; source: string }> = [];
    (piStream as any).mockImplementation(() => (async function* () {
      yield { type: "text_delta", delta: "Partial" };
      yield { type: "tool_call_start", id: "big", name: "shell" };
      yield { type: "done", reason: "timeout", message: {
        role: "assistant", content: [
          { type: "text", text: "Partial" },
          { type: "tool_use", id: "big", name: "shell", arguments: { command: "x".repeat(4000) } },
        ],
      } };
    })());
    await runTurn(session, "hello", undefined, {
      sink: { onContextHistoryDelta: (delta) => deltas.push(delta) },
    });
    expect(deltas.filter((delta) => delta.source === "assistant").map((delta) => delta.tokensAdded))
      .toEqual([estimateAssistantMessageTokens({ role: "assistant", content: "Partial" })]);
  });

  it("does not retry a step-0 idle timeout after partial text", async () => {
    const session = makeMockSession();
    session.config.llm.stream_idle_timeout_ms = 5_000;
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    const texts: string[] = [];
    const errors: string[] = [];
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      return (async function* () {
        yield { type: "text_delta", delta: "Hello" };
        yield {
          type: "done",
          reason: "timeout",
          message: { role: "assistant", content: "Hello" },
        };
      })();
    });

    const response = await runTurn(session, "hello", undefined, {
      sink: {
        onTextDelta: (delta) => texts.push(delta),
        onError: (entry) => errors.push(entry.message),
      },
    });

    expect(callCount).toBe(1);
    expect(texts).toEqual(["Hello"]);
    expect(response.match(/Hello/g)?.length).toBe(1);
    expect(errors).toContain(IDLE_TIMEOUT_ERROR);
  });

  it("retries and falls back when attempts emit only thinking", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    let calls = 0;
    (piStream as any).mockImplementation(() => {
      calls++;
      const attempt = calls;
      return (async function* () {
        if (attempt < 3) {
          yield { type: "thinking_delta", delta: "thinking" };
          yield { type: "done", reason: "stop", message: { role: "assistant", content: "" } };
        } else {
          yield { type: "text_delta", delta: "answer" };
          yield { type: "done", reason: "stop", message: { role: "assistant", content: "answer" } };
        }
      })();
    });
    const result = await runTurn(session, "hello");
    expect(calls).toBe(3);
    expect(result).toContain("answer");
  });

  it("does not fall back when the second attempt already streamed text", async () => {
    const session = makeMockSession();
    session.config.llm.stream_idle_timeout_ms = 5_000;
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    const texts: string[] = [];
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return (async function* () {
          yield { type: "done", reason: "timeout", message: { role: "assistant", content: "" } };
        })();
      }
      if (callCount === 2) {
        return (async function* () {
          yield { type: "text_delta", delta: "Partial" };
          yield {
            type: "done",
            reason: "timeout",
            message: { role: "assistant", content: "Partial" },
          };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "fallback should not run" };
        yield {
          type: "done",
          reason: "stop",
          message: { role: "assistant", content: "fallback should not run" },
        };
      })();
    });

    const response = await runTurn(session, "hello", undefined, {
      sink: { onTextDelta: (delta) => texts.push(delta) },
    });

    expect(callCount).toBe(2);
    expect(texts).toEqual(["Partial"]);
    expect(response).toContain("Partial");
    expect(response).not.toContain("fallback should not run");
    expect(session.getEffectiveProvider()).toBe("umans");
  });
});

function prematureEnd(retryable: boolean, message = "stream ended before the provider sent a final event (message_stop)") {
  return (async function* () {
    yield {
      type: "error",
      error: new Error(message),
      retryable,
      kind: "premature_end" as const,
    };
  })();
}

describe("premature stream end retry", () => {
  beforeEach(() => {
    (piStream as any).mockReset();
  });

  it("retries once at step 0 when nothing was emitted and the end is retryable", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return prematureEnd(true);
      return (async function* () {
        yield { type: "text_delta", delta: "recovered" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "recovered" } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("recovered");
    expect(callCount).toBe(2);
    expect(session.getEffectiveProvider()).toBe("umans");
  });

  it("retries a premature end when the message text is reworded", async () => {
    const session = makeMockSession();
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return prematureEnd(true, "the socket closed early");
      return (async function* () {
        yield { type: "text_delta", delta: "recovered" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "recovered" } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("recovered");
    expect(callCount).toBe(2);
  });

  it("does not retry the old premature-end sentence when the kind marker is absent", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      return (async function* () {
        yield {
          type: "error",
          error: new Error("stream ended before the provider sent a final event (message_stop)"),
          retryable: true,
        };
      })();
    });

    await runTurn(session, "hello");
    expect(callCount).toBe(1);
  });

  it("skips the step-0 retry for a connect timeout and goes to the fallback", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return (async function* () {
          yield {
            type: "error",
            error: new Error("ETIMEDOUT: connect timeout after 60000ms (llm.connect_timeout_ms)"),
            retryable: false,
            kind: "connect_timeout",
          };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "fallback" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "fallback" } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("fallback");
    expect(callCount).toBe(2);
    expect(session.getEffectiveProvider()).toBe("openrouter");
  });

  it("retries a mid-stream ETIMEDOUT that is not a connect timeout", async () => {
    const session = makeMockSession();
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return (async function* () {
          yield {
            type: "error",
            error: new Error("read ETIMEDOUT: timeout while reading the response body"),
            retryable: false,
          };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "retried" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "retried" } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("retried");
    expect(callCount).toBe(2);
  });

  it("skips the step-0 retry for a connect timeout marker without matching the message text", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return (async function* () {
          yield {
            type: "error",
            error: new Error("timeout"),
            retryable: false,
            kind: "connect_timeout",
          };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "fallback" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "fallback" } };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("fallback");
    expect(callCount).toBe(2);
    expect(session.getEffectiveProvider()).toBe("openrouter");
  });

  it("falls back after the one premature-end retry also fails", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      if (callCount <= 2) return prematureEnd(true);
      return (async function* () {
        yield { type: "text_delta", delta: "fallback recovered" };
        yield {
          type: "done",
          reason: "stop",
          message: { role: "assistant", content: "fallback recovered" },
        };
      })();
    });

    const response = await runTurn(session, "hello");
    expect(response).toContain("fallback recovered");
    expect(callCount).toBe(3);
    expect(session.getEffectiveProvider()).toBe("openrouter");
  });

  it("does not retry a premature end after text was already shown", async () => {
    const session = makeMockSession();
    session.config.llm.fallback_provider = "openrouter";
    session.config.llm.fallback_model = "fallback-model";
    const texts: string[] = [];
    const errors: string[] = [];
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      return (async function* () {
        yield { type: "text_delta", delta: "Partial" };
        yield {
          type: "error",
          error: new Error("stream ended before the provider sent a final event (message_stop)"),
          retryable: true,
        };
      })();
    });

    const response = await runTurn(session, "hello", undefined, {
      sink: {
        onTextDelta: (delta) => texts.push(delta),
        onError: (entry) => errors.push(entry.message),
      },
    });

    expect(callCount).toBe(1);
    expect(texts).toEqual(["Partial"]);
    expect(response).toContain("Partial");
    expect(errors.some((message) => message.includes("stream ended before"))).toBe(true);
  });

  it("does not retry a premature end after a tool call was emitted", async () => {
    const session = makeMockSession();
    let callCount = 0;
    (piStream as any).mockImplementation(() => {
      callCount += 1;
      return (async function* () {
        yield { type: "tool_call_start", id: "call_1", name: "shell" };
        yield {
          type: "error",
          error: new Error("stream ended before the provider sent a final event (message_stop)"),
          retryable: true,
        };
      })();
    });

    await runTurn(session, "hello");
    expect(callCount).toBe(1);
  });
});
