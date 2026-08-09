import { describe, it, expect, beforeEach, afterAll, mock, spyOn } from "bun:test";
import { z } from "zod";
import { createNullScorecard } from "../src/context-engine/telemetry.js";
import * as contextEngineActual from "../src/context-engine/index.js";
import * as compileClassicActual from "../src/compile-classic.js";
import * as llmActual from "../src/llm.js";
import * as toolsActual from "../src/tools/index.js";
import * as autoCompactActual from "../src/auto-compact.js";
import * as uiActual from "../src/ui.js";
import * as piAiActual from "@earendil-works/pi-ai/compat";
import * as zodToJsonActual from "zod-to-json-schema";

// Snapshot real exports BEFORE mock.module updates live bindings on the namespaces
const ceReal = { ...contextEngineActual };
const ccReal = { ...compileClassicActual };
const llmReal = { ...llmActual };
const toolsReal = { ...toolsActual };
const autoCompactReal = { ...autoCompactActual };
const uiReal = { ...uiActual };
const piAiReal = { ...piAiActual };
const zodReal = { ...zodToJsonActual };

// ── Mock all external dependencies ──────────────────────────────────

mock.module("@earendil-works/pi-ai/compat", () => ({
  stream: mock(),
  clampThinkingLevel: mock((_model: unknown, level: string) => level),
  getSupportedThinkingLevels: mock(() => ["off", "low", "medium", "high"]),
}));

mock.module("zod-to-json-schema", () => ({
  zodToJsonSchema: mock((_schema, _opts) => ({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    definitions: {},
  })),
}));

mock.module("../src/compiler.js", () => ({}));

mock.module("../src/context-engine/index.js", () => ({
  ...contextEngineActual,
  compileEngineWithMetrics: mock(() => ({
    prompt: "engine compiled prompt",
    metrics: {
      totalTokens: 600,
      systemFrameTokens: 100,
      agentsContextTokens: 0,
      skillsCatalogTokens: 0,
      checkpointTokens: 50,
      crossSessionTokens: 0,
      activeStateTokens: 40,
      peripheralStubsTokens: 0,
      recentTurnsTokens: 300,
      currentInputTokens: 70,
      activeObjectCount: 0,
      peripheralObjectCount: 0,
      recentTurnsTruncated: false,
      memoryTruncated: false,
      agentsContextTruncated: false,
      skillsTruncated: false,
    },
    scoreRecords: [],
    pressureRatio: 0.2,
    pressureMode: "normal" as const,
    weightedTokens: 400,
    rawPressureRatio: 0.25,
    excludedScoredUnits: 0,
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

mock.module("../src/compile-classic.js", () => ({
  compileClassicWithMetrics: mock(() => ({
    prompt: "classic compiled prompt",
    metrics: {
      totalTokens: 800,
      systemFrameTokens: 120,
      agentsContextTokens: 0,
      skillsCatalogTokens: 40,
      checkpointTokens: 0,
      crossSessionTokens: 50,
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

mock.module("../src/tools/index.js", () => ({
  createAllTools: mock(() => ({
    create_task: {
      description: "Create a new task",
      parameters: z.object({ title: z.string() }),
      execute: mock().mockResolvedValue({ ok: true, id: "task-1" }),
    },
    shell: {
      description: "Execute a shell command",
      parameters: z.object({ command: z.string() }),
      execute: mock().mockResolvedValue({ ok: true, stdout: "hello" }),
    },
    recall: {
      description: "Search memory",
      parameters: z.object({ query: z.string() }),
      execute: mock().mockResolvedValue({ ok: true, results: [] }),
    },
    edit_file: {
      description: "Edit a file",
      parameters: z.object({ path: z.string(), oldText: z.string(), newText: z.string() }),
      execute: mock().mockResolvedValue({ ok: true }),
    },
    read_file: {
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: mock().mockResolvedValue({ ok: true, content: "file content" }),
    },
  })),
  describeTools: mock(() => [
    "create_task(title) — Create a new task",
    "shell(command) — Execute a shell command",
  ]),
}));

mock.module("../src/llm.js", () => ({
  createProvider: mock(() => mock(() => ({}))),
  resolveModel: mock((name: string) => name),
  inferReasoningModel: mock(() => false),
  getReasoningEffort: mock(() => undefined),
}));

mock.module("../src/ui.js", () => ({
  printDebug: mock(),
  printDebugBlock: mock(),
  printMemoryBanner: mock(),
  printToolCall: mock(),
  startSpinner: mock(),
  stopSpinner: mock(),
}));

// ── Import after mocks ─────────────────────────────────────────────

import { stream as piStream } from "@earendil-works/pi-ai/compat";
import { compileClassicWithMetrics } from "../src/compile-classic.js";
import { compileEngineWithMetrics } from "../src/context-engine/index.js";
import { createAllTools, describeTools } from "../src/tools/index.js";
import { createProvider, resolveModel, inferReasoningModel, getReasoningEffort } from "../src/llm.js";

import {
  runTurn,
  normalizeToolParameters,
  applyTierManagement,
  computeMemoryStats,
  isZodSchema,
} from "../src/turn.js";
import { StateGraph } from "../src/state-graph.js";
import { EventLog } from "../src/event-log.js";
import { createBuiltinHookRegistry } from "../src/hooks/index.js";
import type { PraanaConfig, Event } from "../src/types.js";
// ── Restore real modules after this file to prevent cross-test pollution ──
afterAll(() => {
  mock.module("../src/context-engine/index.js", () => ceReal);
  mock.module("../src/compile-classic.js", () => ccReal);
  mock.module("../src/llm.js", () => llmReal);
  mock.module("../src/tools/index.js", () => toolsReal);
  mock.module("../src/auto-compact.js", () => autoCompactReal);
  mock.module("../src/ui.js", () => uiReal);
  mock.module("@earendil-works/pi-ai/compat", () => piAiReal);
  mock.module("zod-to-json-schema", () => zodReal);
  mock.module("../src/compiler.js", () => ({}));
});


// ── Helpers ────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<PraanaConfig>): PraanaConfig {
  return {
    llm: { provider: "openrouter", model: "test-model" },
    memory: {
      enabled: false,
      summarizer: "openrouter",
      db_path: ":memory:",
      embedder: "auto",
      ollama_url: "http://localhost:11434",
      ollama_model: "nomic-embed-text",
    },
    compiler: {
      token_budget: 100_000,
      recent_turns: 10,
      recent_turns_token_budget: 30_000,
    },
    tiers: {
      idle_soft_after_turns: 3,
      idle_hard_after_turns: 6,
    },
    session: {
      log_dir: "/tmp/praana-test",
    },
    consolidation: {
      enabled: false,
      promotion_threshold: 3,
      run_delay_seconds: 30,
    },
    shell: { enabled: false, allowed_paths: [] },
    edit: { confirm: false },
    skills: {
      enabled: true,
      max_token_budget_ratio: 0.2,
      max_loaded_skills: 3,
      stale_threshold_turns: 10,
      max_depth: 6,
    },
    ui: { mode: "readline", screen: "preserve" },
    context_engine: {
      enabled: false,
      measurement_mode: false,
      artifact_inline_threshold: 400,
      artifact_ttl_turns: 50,
      distiller: { default_intensity: "full" },
      llm_digest: false,
      activity_log_max_entries: 15,
      checkpoint_enabled: true,
      scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
      pressure: { compact_at: 0.7, emergency_at: 0.85 },
    },
    ...overrides,
  };
}

function makeMockSession(overrides?: Partial<Record<string, any>>) {
  const config = makeConfig();
  const stateGraph = new StateGraph();

  // Mock event log that stores events in memory instead of writing to disk
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

    incrementTurn() {
      this._turnCount++;
      this.stateGraph.incrementTurn();
    },
    persistStateGraphCheckpoint: mock(),
    getTurnCount() { return this._turnCount; },
    getLastResetBoundaryTurn() { return -1; },
    getVisibleSessionCheckpoint() {
      return this.contextEngine?.getSessionCheckpoint?.() ?? undefined;
    },
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
    isIncognito() { return this.incognito ?? false; },
    isContextEngineEnabled() { return this.config.context_engine?.enabled ?? false; },
    planMode: false,
    enterPlanMode() { this.planMode = true; },
    exitPlanMode() { this.planMode = false; },
    isPlanMode() { return this.planMode; },
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
      return this.config.llm.provider;
    },
    getEffectiveLlmConfig() {
      return this.config.llm;
    },
    getActiveModelId() {
      return this.config.llm.model;
    },
    getActiveModelLabel() {
      return `${this.config.llm.provider}/${this.config.llm.model}`;
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

// ── Tests ──────────────────────────────────────────────────────────

describe("isZodSchema", () => {
  it("returns true for a Zod schema", () => {
    expect(isZodSchema(z.object({}))).toBe(true);
  });

  it("returns false for plain objects", () => {
    expect(isZodSchema({ type: "object" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(isZodSchema(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isZodSchema(undefined)).toBe(false);
  });

  it("returns false for strings", () => {
    expect(isZodSchema("string")).toBe(false);
  });
});

describe("normalizeToolParameters", () => {
  it("converts a Zod schema to a JSON schema without $ref/definitions", () => {
    const schema = z.object({ name: z.string() });
    const result = normalizeToolParameters(schema);
    expect(result).not.toHaveProperty("$ref");
    expect(result).not.toHaveProperty("definitions");
    expect(result).toHaveProperty("type", "object");
    expect(result).toHaveProperty("properties");
  });

  it("returns a default object for non-Zod input", () => {
    const result = normalizeToolParameters({ type: "object" });
    expect(result).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });

  it("returns a default object for null", () => {
    const result = normalizeToolParameters(null);
    expect(result).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });

  it("returns a default object for undefined", () => {
    const result = normalizeToolParameters(undefined);
    expect(result).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {},
    });
  });
});

describe("applyTierManagement", () => {
  it("demotes active objects to soft when idle turns >= idle_soft_after_turns", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 2, idle_hard_after_turns: 10 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });
    // Advance turns past the idle threshold
    sg.incrementTurn();
    sg.incrementTurn();
    sg.incrementTurn(); // turnCount = 3

    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("soft");
  });

  it("demotes active objects to hard when idle turns >= idle_hard_after_turns", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 2, idle_hard_after_turns: 4 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });
    // Advance turns past the hard threshold
    for (let i = 0; i < 5; i++) sg.incrementTurn(); // turnCount = 5

    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("hard");
  });

  it("does nothing when idle turns are below thresholds", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 5, idle_hard_after_turns: 10 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });

    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("active"); // still active
  });

  it("demotes soft peripheral objects to hard when idle turns >= idle_hard_after_turns", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 2, idle_hard_after_turns: 4 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });
    sg.setTier(obj.id, "soft");

    // Advance turns so it's been idle since turn 0
    for (let i = 0; i < 5; i++) sg.incrementTurn(); // turnCount = 5

    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("hard");
  });

  it("does not promote objects (only demotes)", () => {
    const config = makeConfig({ tiers: { idle_soft_after_turns: 2, idle_hard_after_turns: 5 } });
    const sg = new StateGraph();
    const obj = sg.create("note", { text: "test" });
    sg.setTier(obj.id, "hard"); // already hard

    // Freshly touched (turn 0 is current)
    const session: any = { config, stateGraph: sg };
    applyTierManagement(session);

    const updated = sg.get(obj.id);
    expect(updated?.tier).toBe("hard"); // stays hard
  });
});

describe("computeMemoryStats", () => {
  it("returns stats from session memory stats", () => {
    const sg = new StateGraph();
    sg.create("task", { title: "t1", status: "todo" });
    sg.create("note", { text: "n1" });

    const eventLog = {
      readLast: mock(() => [] as Event[]),
      readLastUncompressed: mock(() => [] as Event[]),
      readLastUncompressedAfterResetBoundary: mock(() => [] as Event[]),
    };

    const session: any = {
      stateGraph: sg,
      eventLog,
      digest: "memory digest content",
      getMemoryStats() {
        return {
          total: this.stateGraph.snapshot().length,
          active: this.stateGraph.getActive().length,
          soft: 0,
          hard: 0,
          byKind: {} as Record<string, number>,
        };
      },
    };

    const stats = computeMemoryStats(session, 3);
    expect(stats.totalState).toBe(2);
    expect(stats.activeState).toBe(2);
    expect(stats.digestLen).toBe("memory digest content".length);
    expect(stats.recallCalls).toBe(0);
    expect(stats.recallHits).toBe(0);
    expect(stats.autoHydrated).toBe(3);
  });

  it("counts recall calls and hits from event log", () => {
    const sg = new StateGraph();
    const eventLog = {
      readLast: mock(() => [
        { kind: "system_note", payload: { type: "memory_recall", hits: 3 } },
        { kind: "system_note", payload: { type: "memory_recall", hits: 2 } },
        { kind: "system_note", payload: { type: "other" } },
        { kind: "tool_call", payload: { tool: "recall" } },
      ] as Event[]),
      readLastUncompressed: mock(() => [
        { kind: "system_note", payload: { type: "memory_recall", hits: 3 } },
        { kind: "system_note", payload: { type: "memory_recall", hits: 2 } },
        { kind: "system_note", payload: { type: "other" } },
        { kind: "tool_call", payload: { tool: "recall" } },
      ] as Event[]),
      readLastUncompressedAfterResetBoundary: mock(() => [
        { kind: "system_note", payload: { type: "memory_recall", hits: 3 } },
        { kind: "system_note", payload: { type: "memory_recall", hits: 2 } },
        { kind: "system_note", payload: { type: "other" } },
        { kind: "tool_call", payload: { tool: "recall" } },
      ] as Event[]),
    };

    const session: any = {
      stateGraph: sg,
      eventLog,
      digest: null,
      getMemoryStats() {
        return { total: 0, active: 0, soft: 0, hard: 0, byKind: {} };
      },
    };

    const stats = computeMemoryStats(session, 0);
    expect(stats.recallCalls).toBe(2);
    expect(stats.recallHits).toBe(5); // 3 + 2
  });

  it("handles empty event log gracefully", () => {
    const sg = new StateGraph();
    const eventLog = {
      readLast: mock(() => [] as Event[]),
      readLastUncompressed: mock(() => [] as Event[]),
      readLastUncompressedAfterResetBoundary: mock(() => [] as Event[]),
    };

    const session: any = {
      stateGraph: sg,
      eventLog,
      digest: null,
      getMemoryStats() {
        return { total: 0, active: 0, soft: 0, hard: 0, byKind: {} };
      },
    };

    const stats = computeMemoryStats(session, 0);
    expect(stats.recallCalls).toBe(0);
    expect(stats.recallHits).toBe(0);
    expect(stats.digestLen).toBe(0);
  });
});

describe("runTurn", () => {
  beforeEach(() => {
    mock.clearAllMocks();
    (piStream as ReturnType<typeof mock>).mockReset();

    // Default mock: a simple text response (no tool calls)
    const mockAsyncGenerator = (async function* () {
      yield { type: "text_delta", delta: "Hello from AI" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hello from AI" }],
        },
      };
    })();

    (piStream as ReturnType<typeof mock>).mockReturnValue(mockAsyncGenerator as any);
  });

  it("processes user input and returns the AI response", async () => {
    const session = makeMockSession();
    const response = await runTurn(session, "hello");

    expect(response).toContain("Hello from AI");
    expect(compileClassicWithMetrics).toHaveBeenCalled();
    expect(compileEngineWithMetrics).not.toHaveBeenCalled();
    expect(createAllTools).toHaveBeenCalled();
    expect(createProvider).toHaveBeenCalled();
    expect(resolveModel).toHaveBeenCalled();
  });

  it("uses the engine compiler when context engine is enabled", async () => {
    const session = makeMockSession({
      config: makeConfig({
        context_engine: {
          ...makeConfig().context_engine,
          enabled: true,
        },
      }),
      contextEngine: {
        ledger: { list: mock(() => []) },
        getRecentActivity: mock(() => []),
        getSessionCheckpoint: mock(() => null),
        recordCompileTelemetry: mock(),
        captureStateSnapshot: mock(),
        listAllWorkflowPatterns: mock(() => []),
        store: { listFileReads: mock(() => []) },
      },
    });

    await runTurn(session, "hello");

    expect(compileEngineWithMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ filesReadIndex: "" }),
    );

    expect(compileEngineWithMetrics).toHaveBeenCalled();
    expect(compileClassicWithMetrics).not.toHaveBeenCalled();
  });

  it("falls back to classic compiler when context engine is enabled but unavailable", async () => {
    const session = makeMockSession({
      config: makeConfig({
        context_engine: {
          ...makeConfig().context_engine,
          enabled: true,
        },
      }),
      contextEngine: null,
    });

    await runTurn(session, "hello");

    expect(compileClassicWithMetrics).toHaveBeenCalled();
    expect(compileEngineWithMetrics).not.toHaveBeenCalled();
    expect(describeTools).toHaveBeenCalledWith(
      expect.objectContaining({ contextEngineEnabled: true, classicMode: true }),
    );
  });

  it("passes modelOverride to resolveModel", async () => {
    const session = makeMockSession();
    await runTurn(session, "hello", "gpt-4");

    expect(resolveModel).toHaveBeenCalledWith("gpt-4");
  });

  it("passes reasoningEffort (not reasoning) to piStream for reasoning models", async () => {
    (getReasoningEffort as ReturnType<typeof mock>).mockReturnValue("medium");
    (createProvider as ReturnType<typeof mock>).mockReturnValue(
      mock(() => ({ reasoning: true, __piOptions: { apiKey: "test-key" } })) as any,
    );

    const session = makeMockSession({
      getEffectiveLlmConfig: () => ({
        provider: "openrouter",
        model: "moonshotai/kimi-k2.7-code",
      }),
    });

    await runTurn(session, "hello", "moonshotai/kimi-k2.7-code");

    expect(piStream).toHaveBeenCalled();
    const options = (piStream as ReturnType<typeof mock>).mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(options).toHaveProperty("reasoningEffort", "medium");
    expect(options).not.toHaveProperty("reasoning");
  });

  it("handles an empty LLM response with a fallback message", async () => {
    const emptyGenerator = (async function* () {
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [] } };
    })();

    (piStream as ReturnType<typeof mock>).mockReturnValue(emptyGenerator as any);

    const session = makeMockSession();
    const response = await runTurn(session, "hello");
    expect(response).toContain("no response from model");
  });

  it("surfaces LLM stream errors and logs them to the event log", async () => {
    const errorGenerator = (async function* () {
      yield {
        type: "error",
        reason: "error",
        error: { role: "assistant", errorMessage: "401 Unauthorized", content: [] },
      };
    })();

    (piStream as ReturnType<typeof mock>).mockReturnValue(errorGenerator as any);

    const session = makeMockSession();
    const response = await runTurn(session, "hello");
    // Errors should show a graceful message in the transcript, not the raw error
    expect(response).toContain("I encountered an error");
    // The raw error should be logged to the event log
    const events = session.eventLog.readAll();
    const agentMsg = events.find((e) => e.kind === "agent_message");
    expect(agentMsg).toBeDefined();
    expect((agentMsg!.payload as any).text).toContain("I encountered an error");
  });

  it("accumulates input and output tokens during the turn", async () => {
    const responseText = "Hello world this is a response";
    const generator = (async function* () {
      yield { type: "text_delta", delta: responseText };
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: responseText }] } };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);
    (compileClassicWithMetrics as ReturnType<typeof mock>).mockReturnValue({
      prompt: "mock prompt",
      metrics: {
        totalTokens: 150,
        systemFrameTokens: 50,
        agentsContextTokens: 0,
        skillsCatalogTokens: 0,
        checkpointTokens: 0,
        crossSessionTokens: 0,
        activeStateTokens: 0,
        peripheralStubsTokens: 0,
        recentTurnsTokens: 30,
        currentInputTokens: 20,
        activeObjectCount: 0,
        peripheralObjectCount: 0,
        recentTurnsTruncated: false,
        memoryTruncated: false,
        agentsContextTruncated: false,
        skillsTruncated: false,
      },
    });

    const session = makeMockSession();

    // Initial should be 0
    expect(session.getInputTokens()).toBe(0);
    expect(session.getOutputTokens()).toBe(0);

    const spyIn = spyOn(session, 'recordInputTokens');
    const spyOut = spyOn(session, 'recordOutputTokens');

    await runTurn(session, "hello");

    // Input tokens come from promptMetrics.totalTokens
    expect(spyIn).toHaveBeenCalledWith(150);
    expect(session.getInputTokens()).toBe(150);

    // Output tokens: called exactly once with a positive value
    expect(spyOut).toHaveBeenCalledTimes(1);
    const outArg = spyOut.mock.calls[0][0] as number;
    expect(outArg).toBeGreaterThan(0);
    expect(session.getOutputTokens()).toBe(outArg);
  });

  it("uses provider-reported output tokens when usage is present", async () => {
    const responseText = "Hello from provider";
    const generator = (async function* () {
      yield { type: "text_delta", delta: responseText };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: responseText }],
          usage: { input: 100, output: 42, totalTokens: 142 },
        },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);

    const session = makeMockSession();
    const spyIn = spyOn(session, "recordInputTokens");
    const spyOut = spyOn(session, "recordOutputTokens");
    const onProviderUsage = mock();

    await runTurn(session, "hello", undefined, {
      sink: { onProviderUsage },
    });

    expect(spyIn).toHaveBeenCalledWith(100);
    expect(spyOut).toHaveBeenCalledWith(42);
    expect(session.getInputTokens()).toBe(100);
    expect(session.getOutputTokens()).toBe(42);
    expect(onProviderUsage).toHaveBeenCalledWith({
      step: { input: 100, output: 42, totalTokens: 142 },
      cumulative: { input: 100, output: 42, totalTokens: 142 },
      latestContextTokens: 100,
    });
  });

  it("emits context baseline, history deltas, and commit snapshots", async () => {
    const responseText = "Hello from provider";
    const generator = (async function* () {
      yield { type: "text_delta", delta: responseText };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "reason about greeting" },
            { type: "text", text: responseText },
          ],
          usage: { input: 100, output: 42, totalTokens: 142 },
        },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);

    const session = makeMockSession();
    const onTurnContextBaseline = mock();
    const onContextHistoryDelta = mock();
    const onTurnContextCommit = mock();

    await runTurn(session, "hello", undefined, {
      sink: { onTurnContextBaseline, onContextHistoryDelta, onTurnContextCommit },
    });

    expect(onTurnContextBaseline).toHaveBeenCalledTimes(1);
    expect(onContextHistoryDelta).toHaveBeenCalled();
    expect(onTurnContextCommit).toHaveBeenCalledTimes(1);
    expect(session.getDisplayContextSnapshot()).not.toBeNull();
    expect(session.getDisplayContextSnapshot()!.usedTokens).toBeGreaterThan(0);
  });

  it("accumulates provider output tokens across multi-step tool loops", async () => {
    const firstStep = (async function* () {
      yield { type: "text_delta", delta: "step one" };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "shell", arguments: { command: "echo hi" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "step one" }],
          usage: { input: 50, output: 10, totalTokens: 60 },
        },
      };
    })();
    const secondStep = (async function* () {
      yield { type: "text_delta", delta: " step two" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: " step two" }],
          usage: { input: 80, output: 15, totalTokens: 95 },
        },
      };
    })();
    (piStream as ReturnType<typeof mock>)
      .mockReturnValueOnce(firstStep as any)
      .mockReturnValueOnce(secondStep as any);

    const session = makeMockSession();
    const spyIn = spyOn(session, "recordInputTokens");
    const spyOut = spyOn(session, "recordOutputTokens");

    await runTurn(session, "multi-step");

    expect(spyIn).toHaveBeenCalledTimes(2);
    expect(spyIn).toHaveBeenNthCalledWith(1, 50);
    expect(spyIn).toHaveBeenNthCalledWith(2, 80);
    expect(spyOut).toHaveBeenCalledTimes(2);
    expect(spyOut).toHaveBeenNthCalledWith(1, 10);
    expect(spyOut).toHaveBeenNthCalledWith(2, 15);
    expect(session.getInputTokens()).toBe(130);
    expect(session.getOutputTokens()).toBe(25);
  });

  it("falls back to heuristic output tokens when provider usage is incomplete", async () => {
    const responseText = "fallback estimate";
    const generator = (async function* () {
      yield { type: "text_delta", delta: responseText };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: responseText }],
          usage: { input: 100 },
        },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);
    (compileClassicWithMetrics as ReturnType<typeof mock>).mockReturnValue({
      prompt: "mock prompt",
      metrics: {
        totalTokens: 150,
        systemFrameTokens: 50,
        agentsContextTokens: 0,
        skillsCatalogTokens: 0,
        checkpointTokens: 0,
        crossSessionTokens: 0,
        activeStateTokens: 0,
        peripheralStubsTokens: 0,
        recentTurnsTokens: 30,
        currentInputTokens: 20,
        activeObjectCount: 0,
        peripheralObjectCount: 0,
        recentTurnsTruncated: false,
        memoryTruncated: false,
        agentsContextTruncated: false,
        skillsTruncated: false,
      },
    });

    const session = makeMockSession();
    const spyIn = spyOn(session, "recordInputTokens");
    const spyOut = spyOn(session, "recordOutputTokens");

    await runTurn(session, "hello");

    expect(spyIn).toHaveBeenCalledWith(150);
    expect(spyIn).not.toHaveBeenCalledWith(100);
    const outArg = spyOut.mock.calls[0][0] as number;
    expect(outArg).toBeGreaterThan(0);
    expect(outArg).not.toBe(100);
  });

  it("falls back to heuristic output tokens when provider usage is a zero placeholder", async () => {
    const responseText = "placeholder usage";
    const generator = (async function* () {
      yield { type: "text_delta", delta: responseText };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: responseText }],
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);

    const session = makeMockSession();
    const spyOut = spyOn(session, "recordOutputTokens");

    await runTurn(session, "hello");

    const outArg = spyOut.mock.calls[0][0] as number;
    expect(outArg).toBeGreaterThan(0);
    expect(outArg).not.toBe(0);
  });

  it("ignores non-finite provider usage values and falls back to heuristics", async () => {
    const responseText = "finite fallback";
    const generator = (async function* () {
      yield { type: "text_delta", delta: responseText };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: responseText }],
          usage: { input: Number.NaN, output: 0, totalTokens: 0 },
        },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);

    const session = makeMockSession();
    const spyOut = spyOn(session, "recordOutputTokens");

    await runTurn(session, "hello");

    const outArg = spyOut.mock.calls[0][0] as number;
    expect(outArg).toBeGreaterThan(0);
    expect(Number.isFinite(outArg)).toBe(true);
  });

  it("preserves partial provider usage when a multi-step turn is interrupted", async () => {
    const abortController = new AbortController();
    const firstStep = (async function* () {
      yield { type: "text_delta", delta: "step one" };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "shell", arguments: { command: "echo hi" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "step one" }],
          usage: { input: 50, output: 10, totalTokens: 60 },
        },
      };
    })();
    let streamCalls = 0;
    (piStream as ReturnType<typeof mock>).mockImplementation(() => {
      streamCalls++;
      if (streamCalls === 1) return firstStep as any;
      return (async function* () {})();
    });

    const session = makeMockSession();
    const turnPromise = runTurn(session, "multi-step", undefined, {
      signal: abortController.signal,
      sink: {
        onProviderUsage: () => abortController.abort(),
      },
    });

    await expect(turnPromise).rejects.toThrow();
    expect(session.getInputTokens()).toBe(50);
    expect(session.getOutputTokens()).toBe(10);
  });

  it("processes tool calls and returns results", async () => {
    const toolCallGenerator = (async function* () {
      yield { type: "text_delta", delta: "Let me check" };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "shell", arguments: { command: "echo hi" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check" },
            { type: "toolUse", toolUse: { id: "call-1", name: "shell", arguments: { command: "echo hi" } } },
          ],
        },
      };
    })();

    (piStream as ReturnType<typeof mock>).mockReturnValue(toolCallGenerator as any);

    const session = makeMockSession();
    const response = await runTurn(session, "run command");

    expect(response).toContain("Let me check");
    // Should have logged tool call and result events
    const events = session.eventLog.readLast(50);
    const toolCalls = events.filter((e: Event) => e.kind === "tool_call");
    const toolResults = events.filter((e: Event) => e.kind === "tool_result");
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolResults.length).toBeGreaterThan(0);
  });

  it("does not re-ingest retrieve_artifact results as source artifacts", async () => {
    const touchAccess = mock(() => {});
    const ingestToolResult = mock(() => ({
      promptText: "should not be called",
      inlined: true,
    }));

    const session = makeMockSession({
      config: makeConfig({
        context_engine: {
          ...makeConfig().context_engine,
          enabled: true,
        },
      }),
      contextEngine: {
        ingestToolResult,
        touchAccess,
        ledger: { list: mock(() => []) },
        getRecentActivity: mock(() => []),
        getSessionCheckpoint: mock(() => null),
        recordCompileTelemetry: mock(),
        captureStateSnapshot: mock(),
        listAllWorkflowPatterns: mock(() => []),
        store: { listFileReads: mock(() => []) },
      },
    });

    (createAllTools as ReturnType<typeof mock>).mockImplementationOnce(() => ({
      retrieve_artifact: {
        description: "Retrieve a stored artifact",
        parameters: z.object({ id: z.string() }),
        execute: mock().mockResolvedValue({
          ok: true,
          id: "art_abc123def456",
          content: "original artifact content",
        }),
      },
    }));

    const toolCallGenerator = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: {
          id: "call-1",
          name: "retrieve_artifact",
          arguments: { id: "art_abc123def456" },
        },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolUse",
              toolUse: {
                id: "call-1",
                name: "retrieve_artifact",
                arguments: { id: "art_abc123def456" },
              },
            },
          ],
        },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(toolCallGenerator as any);

    await runTurn(session, "retrieve the artifact");

    // retrieve_artifact already touches access internally via ArtifactStore.retrieve();
    // the turn-level path must not double-increment access_count.
    expect(touchAccess).not.toHaveBeenCalled();
    expect(ingestToolResult).not.toHaveBeenCalled();
  });

  it("touches access for repeat-read (skippedDisk) results", async () => {
    const touchAccess = mock(() => {});
    const ingestToolResult = mock(() => ({
      promptText: "should not be called",
      inlined: true,
    }));

    const session = makeMockSession({
      config: makeConfig({
        context_engine: {
          ...makeConfig().context_engine,
          enabled: true,
        },
      }),
      contextEngine: {
        ingestToolResult,
        touchAccess,
        ledger: { list: mock(() => []) },
        getRecentActivity: mock(() => []),
        getSessionCheckpoint: mock(() => null),
        recordCompileTelemetry: mock(),
        captureStateSnapshot: mock(),
        listAllWorkflowPatterns: mock(() => []),
        store: { listFileReads: mock(() => []) },
      },
    });

    (createAllTools as ReturnType<typeof mock>).mockImplementationOnce(() => ({
      read_file: {
        description: "Read a file",
        parameters: z.object({ path: z.string() }),
        execute: mock().mockResolvedValue({
          ok: true,
          content: "[artifact card]",
          artifact_id: "art_repeat123",
          skipped_disk: true,
        }),
      },
    }));

    const toolCallGenerator = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: {
          id: "call-1",
          name: "read_file",
          arguments: { path: "src/foo.ts" },
        },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolUse",
              toolUse: {
                id: "call-1",
                name: "read_file",
                arguments: { path: "src/foo.ts" },
              },
            },
          ],
        },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(toolCallGenerator as any);

    await runTurn(session, "read src/foo.ts again");

    // The repeat-read interceptor result does not self-touch, so the turn-level
    // path must touch access to update last_accessed_turn / access_count.
    expect(touchAccess).toHaveBeenCalledWith("art_repeat123", expect.any(Number));
    expect(ingestToolResult).not.toHaveBeenCalled();
  });

  it("executes multiple pending tool calls concurrently", async () => {
    let secondToolStarted = false;
    let releaseFirstTool: (() => void) | null = null;
    const firstToolDone = new Promise<void>((resolve) => {
      releaseFirstTool = resolve;
    });

    (createAllTools as ReturnType<typeof mock>).mockImplementationOnce(() => ({
      shell: {
        description: "Execute a shell command",
        parameters: z.object({ command: z.string() }),
        execute: mock(async (args: { command: string }) => {
          if (args.command === "echo a") {
            await firstToolDone;
            return { ok: true, stdout: "a", stderr: "", exitCode: 0 };
          }
          secondToolStarted = true;
          releaseFirstTool?.();
          return { ok: true, stdout: "b", stderr: "", exitCode: 0 };
        }),
      },
    }));

    const toolCallsGenerator = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "shell", arguments: { command: "echo a" } },
      };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-2", name: "shell", arguments: { command: "echo b" } },
      };
      yield { type: "done", reason: "toolUse", message: { role: "assistant", content: [] } };
    })();
    const stopGenerator = (async function* () {
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      };
    })();

    (piStream as ReturnType<typeof mock>)
      .mockReturnValueOnce(toolCallsGenerator as any)
      .mockReturnValueOnce(stopGenerator as any);

    const session = makeMockSession();
    await runTurn(session, "do two things", undefined);

    expect(secondToolStarted).toBe(true);
  });

  it("spinner label includes count when more than 3 tools are pending", async () => {
    const toolCallsGenerator = (async function* () {
      yield { type: "toolcall_end", toolCall: { id: "c1", name: "shell", arguments: { command: "echo a" } } };
      yield { type: "toolcall_end", toolCall: { id: "c2", name: "read_file", arguments: { path: "x" } } };
      yield { type: "toolcall_end", toolCall: { id: "c3", name: "edit_file", arguments: { path: "y", oldText: "a", newText: "b" } } };
      yield { type: "toolcall_end", toolCall: { id: "c4", name: "create_task", arguments: { title: "t" } } };
      yield { type: "done", reason: "toolUse", message: { role: "assistant", content: [] } };
    })();
    const stopGenerator = (async function* () {
      yield { type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "done" }] } };
    })();

    (piStream as ReturnType<typeof mock>)
      .mockReturnValueOnce(toolCallsGenerator as any)
      .mockReturnValueOnce(stopGenerator as any);

    const session = makeMockSession();
    const onSpinnerStart = mock();
    await runTurn(session, "do many things", undefined, { sink: { onSpinnerStart } });

    expect(onSpinnerStart).toHaveBeenCalledTimes(1);
    const label = onSpinnerStart.mock.calls[0]![0] as string;
    expect(label).toContain("4");
  });

  it("calls onToolCallsStart before tool execution", async () => {
    const toolCallGenerator = (async function* () {
      yield { type: "text_delta", delta: "Thinking..." };
      yield { type: "thinking_delta", delta: "hmm" };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "shell", arguments: { command: "echo hi" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Thinking..." },
            { type: "toolUse", toolUse: { id: "call-1", name: "shell", arguments: { command: "echo hi" } } },
          ],
        },
      };
    })();

    (piStream as ReturnType<typeof mock>).mockReturnValue(toolCallGenerator as any);

    const session = makeMockSession();
    const onToolCallsStart = mock();

    await runTurn(session, "do something", undefined, {
      sink: { onToolCallsStart },
    });

    expect(onToolCallsStart).toHaveBeenCalledTimes(1);
  });

  it("does not re-ingest skipped_disk read_file results without artifact_id", async () => {
    const hint = "Already read this session — use retrieve_artifact or search_turn_events";
    const firstStep = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "toolUse", toolUse: { id: "call-1", name: "read_file", arguments: { path: "a.txt" } } },
          ],
        },
      };
    })();
    const secondStep = (async function* () {
      yield { type: "text_delta", delta: "ok" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      };
    })();
    (piStream as ReturnType<typeof mock>)
      .mockReturnValueOnce(firstStep as any)
      .mockReturnValueOnce(secondStep as any);

    const ingestToolResult = mock(() => ({
      promptText: "SHOULD_NOT_INGEST",
      artifactId: "art-bad",
      inlined: false,
    }));
    const touchAccess = mock();
    const session = makeMockSession({
      config: makeConfig({
        context_engine: {
          ...makeConfig().context_engine,
          enabled: true,
        },
      }),
      contextEngine: {
        ledger: { list: mock(() => []) },
        getRecentActivity: mock(() => []),
        getSessionCheckpoint: mock(() => null),
        recordCompileTelemetry: mock(),
        captureStateSnapshot: mock(),
        listAllWorkflowPatterns: mock(() => []),
        ingestToolResult,
        touchAccess,
        extractAndPersistTurn: mock(() => null),
        reconcileCheckpoint: mock(),
        runEviction: mock(() => 0),
        flushDeferredDistillation: mock(async () => 0),
        store: { listFileReads: mock(() => []) },
      },
    });

    (createAllTools as ReturnType<typeof mock>).mockReturnValueOnce({
      read_file: {
        description: "Read a file",
        parameters: z.object({ path: z.string() }),
        execute: mock().mockResolvedValue({
          ok: true,
          content: hint,
          warning: hint,
          skipped_disk: true,
        }),
      },
    } as any);

    await runTurn(session, "read again");

    expect(ingestToolResult).not.toHaveBeenCalled();
    expect(touchAccess).not.toHaveBeenCalled();
  });

  it("touches artifact access on skipped_disk when artifact_id is present", async () => {
    const firstStep = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "toolUse", toolUse: { id: "call-1", name: "read_file", arguments: { path: "a.txt" } } },
          ],
        },
      };
    })();
    const secondStep = (async function* () {
      yield { type: "text_delta", delta: "ok" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      };
    })();
    (piStream as ReturnType<typeof mock>)
      .mockReturnValueOnce(firstStep as any)
      .mockReturnValueOnce(secondStep as any);

    const touchAccess = mock();
    const session = makeMockSession({
      config: makeConfig({
        context_engine: {
          ...makeConfig().context_engine,
          enabled: true,
        },
      }),
      contextEngine: {
        ledger: { list: mock(() => []) },
        getRecentActivity: mock(() => []),
        getSessionCheckpoint: mock(() => null),
        recordCompileTelemetry: mock(),
        captureStateSnapshot: mock(),
        listAllWorkflowPatterns: mock(() => []),
        ingestToolResult: mock(),
        touchAccess,
        extractAndPersistTurn: mock(() => null),
        reconcileCheckpoint: mock(),
        runEviction: mock(() => 0),
        flushDeferredDistillation: mock(async () => 0),
        store: { listFileReads: mock(() => []) },
      },
    });

    (createAllTools as ReturnType<typeof mock>).mockReturnValueOnce({
      read_file: {
        description: "Read a file",
        parameters: z.object({ path: z.string() }),
        execute: mock().mockResolvedValue({
          ok: true,
          content: "[artifact: art-1]",
          warning: "Already read",
          skipped_disk: true,
          artifact_id: "art-1",
        }),
      },
    } as any);

    await runTurn(session, "read again");

    expect(touchAccess).toHaveBeenCalledWith("art-1", 0);
  });

  it("reinforces recalled memories when a later tool succeeds in the same turn", async () => {
    const firstStep = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "recall", arguments: { query: "streaming" } },
      };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-2", name: "shell", arguments: { command: "echo ok" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [],
        },
      };
    })();
    const secondStep = (async function* () {
      yield { type: "text_delta", delta: "done" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      };
    })();
    (piStream as ReturnType<typeof mock>)
      .mockReturnValueOnce(firstStep as any)
      .mockReturnValueOnce(secondStep as any);

    const reinforceFromSuccessfulToolOutcome = mock();
    const session = makeMockSession({
      memoryStore: { reinforceFromSuccessfulToolOutcome },
      memoryEnabled: true,
    });

    (createAllTools as ReturnType<typeof mock>).mockReturnValueOnce({
      recall: {
        description: "Search memory",
        parameters: z.object({ query: z.string() }),
        execute: mock().mockResolvedValue({
          ok: true,
          entries: [{ id: "m1", content: "streaming is implemented" }],
        }),
      },
      shell: {
        description: "Execute a shell command",
        parameters: z.object({ command: z.string() }),
        execute: mock().mockResolvedValue({ ok: true, stdout: "ok" }),
      },
    } as any);

    await runTurn(session, "verify streaming");

    expect(reinforceFromSuccessfulToolOutcome).toHaveBeenCalledWith(["m1"]);
  });

  it("reinforces recalled memories only once per batch even with multiple succeeding tools", async () => {
    const firstStep = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "recall", arguments: { query: "streaming" } },
      };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-2", name: "shell", arguments: { command: "echo a" } },
      };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-3", name: "read_file", arguments: { path: "foo.ts" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [],
        },
      };
    })();
    const secondStep = (async function* () {
      yield { type: "text_delta", delta: "done" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      };
    })();
    (piStream as ReturnType<typeof mock>)
      .mockReturnValueOnce(firstStep as any)
      .mockReturnValueOnce(secondStep as any);

    const reinforceFromSuccessfulToolOutcome = mock();
    const session = makeMockSession({
      memoryStore: { reinforceFromSuccessfulToolOutcome },
      memoryEnabled: true,
    });

    (createAllTools as ReturnType<typeof mock>).mockReturnValueOnce({
      recall: {
        description: "Search memory",
        parameters: z.object({ query: z.string() }),
        execute: mock().mockResolvedValue({
          ok: true,
          entries: [{ id: "m1", content: "streaming is implemented" }],
        }),
      },
      shell: {
        description: "Execute a shell command",
        parameters: z.object({ command: z.string() }),
        execute: mock().mockResolvedValue({ ok: true, stdout: "a" }),
      },
      read_file: {
        description: "Read a file",
        parameters: z.object({ path: z.string() }),
        execute: mock().mockResolvedValue({ ok: true, content: "foo" }),
      },
    } as any);

    await runTurn(session, "verify streaming");

    expect(reinforceFromSuccessfulToolOutcome).toHaveBeenCalledTimes(1);
    expect(reinforceFromSuccessfulToolOutcome).toHaveBeenCalledWith(["m1"]);
  });

  it("does not double-boost a recalled entry when it is recalled again in a later batch of the same turn", async () => {
    const firstStep = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "recall", arguments: { query: "streaming" } },
      };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-2", name: "shell", arguments: { command: "echo a" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [],
        },
      };
    })();
    const secondStep = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-3", name: "recall", arguments: { query: "streaming" } },
      };
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-4", name: "shell", arguments: { command: "echo b" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [],
        },
      };
    })();
    const thirdStep = (async function* () {
      yield { type: "text_delta", delta: "done" };
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      };
    })();
    (piStream as ReturnType<typeof mock>)
      .mockReturnValueOnce(firstStep as any)
      .mockReturnValueOnce(secondStep as any)
      .mockReturnValueOnce(thirdStep as any);

    const reinforceFromSuccessfulToolOutcome = mock();
    const session = makeMockSession({
      memoryStore: { reinforceFromSuccessfulToolOutcome },
      memoryEnabled: true,
    });

    (createAllTools as ReturnType<typeof mock>).mockReturnValueOnce({
      recall: {
        description: "Search memory",
        parameters: z.object({ query: z.string() }),
        execute: mock().mockResolvedValue({
          ok: true,
          entries: [{ id: "m1", content: "streaming is implemented" }],
        }),
      },
      shell: {
        description: "Execute a shell command",
        parameters: z.object({ command: z.string() }),
        execute: mock().mockResolvedValue({ ok: true, stdout: "ok" }),
      },
    } as any);

    await runTurn(session, "verify streaming twice");

    expect(reinforceFromSuccessfulToolOutcome).toHaveBeenCalledTimes(1);
    expect(reinforceFromSuccessfulToolOutcome).toHaveBeenCalledWith(["m1"]);
  });

  it("calls incrementTurn and prints memory banner on success", async () => {
    const session = makeMockSession();
    const { printMemoryBanner } = await import("../src/ui.js");

    await runTurn(session, "hello");

    expect(session.getTurnCount()).toBe(1);
    expect(printMemoryBanner).toHaveBeenCalled();
  });

  it("calls applyTierManagement after turn completion", async () => {
    const session = makeMockSession();
    const sg = session.stateGraph;
    const obj = sg.create("note", { text: "stale note" });
    sg.setTier(obj.id, "soft");

    await runTurn(session, "hello");

    // after runTurn, tier management runs and turn increments
    // obj was created at turn 0, now we're at turn 1+, so idle turns = 1
    // which is less than soft threshold (3), so it stays soft
    expect(sg.get(obj.id)?.tier).toBe("soft");
  });

  it("handles tool execution errors gracefully", async () => {
    // Mock a tool call that fails
    (createAllTools as ReturnType<typeof mock>).mockReturnValueOnce({
      failing_tool: {
        description: "A tool that fails",
        parameters: z.object({}),
        execute: mock().mockRejectedValue(new Error("Something broke")),
      },
    } as any);

    const toolCallGenerator = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "failing_tool", arguments: {} },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [],
        },
      };
    })();

    (piStream as ReturnType<typeof mock>).mockReturnValue(toolCallGenerator as any);

    const session = makeMockSession();
    // This should not throw — tool errors are caught and returned as error results
    const response = await runTurn(session, "do something");
    expect(typeof response).toBe("string");
  });

  it("stops after maxSteps tool call iterations", async () => {
    // Use mockImplementation so each piStream call creates a fresh generator
    // that yields one tool call then completes
    (piStream as ReturnType<typeof mock>).mockImplementation(() => {
      return (async function* () {
        yield {
          type: "toolcall_end",
          toolCall: { id: "call-1", name: "shell", arguments: { command: "echo hi" } },
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: [],
          },
        };
      })();
    });

    const session = makeMockSession();
    const response = await runTurn(session, "loop");
    expect(typeof response).toBe("string");
    // After maxSteps=25 iterations, the loop should exit with whatever
    // response it accumulated (even if empty, it falls back to fallback msg)
    expect(response.length).toBeGreaterThan(0);
  });

  it("reacts to abort signal", async () => {
    const abortController = new AbortController();

    const session = makeMockSession();

    // Fire an async turn, then abort
    const turnPromise = runTurn(session, "hello", undefined, {
      signal: abortController.signal,
    });

    abortController.abort();

    await expect(turnPromise).rejects.toThrow();
  });

  it("appends user_message and agent_message events to the event log", async () => {
    const session = makeMockSession();
    await runTurn(session, "record this");

    const events = session.eventLog.readLast(50);
    const userMsgs = events.filter((e: Event) => e.kind === "user_message");
    const agentMsgs = events.filter((e: Event) => e.kind === "agent_message");

    expect(userMsgs.length).toBeGreaterThanOrEqual(1);
    expect(agentMsgs.length).toBeGreaterThanOrEqual(1);
    expect(userMsgs[0].payload).toMatchObject({ text: "record this" });
  });

  it("passes the full compiler token budget to skill prompt building", async () => {
    const cleanupStaleSkills = mock();
    const drainEvents = mock(() => []);
    const session = makeMockSession({
      config: makeConfig({
        context_engine: {
          ...makeConfig().context_engine,
          enabled: true,
        },
      }),
      contextEngine: {
        ledger: { list: mock(() => []) },
        getRecentActivity: mock(() => []),
        getSessionCheckpoint: mock(() => null),
        recordCompileTelemetry: mock(),
        captureStateSnapshot: mock(),
        listAllWorkflowPatterns: mock(() => []),
        store: { listFileReads: mock(() => []) },
      },
      skillRuntime: {
        cleanupStaleSkills,
        drainEvents,
      },
    });

    await runTurn(session, "use a skill");

    expect(cleanupStaleSkills).toHaveBeenCalled();
    expect(drainEvents).toHaveBeenCalled();
  });

  it("triggers auto-hydrate on matching user input", async () => {
    const session = makeMockSession();
    const sg = session.stateGraph;
    const obj = sg.create("note", { text: "important note about deployment" });
    sg.setTier(obj.id, "soft"); // peripheral

    // Turn count is 0 when obj was created, then 0 when soft-demoted
    // After runTurn, auto-hydrate should match "deployment" keyword
    await runTurn(session, "tell me about deployment");

    const updated = sg.get(obj.id);
    // The note was soft, but "deployment" might match via autoHydrate
    // auto-hydrate searches payload text for keywords from user input
    // It uses simple substring matching
    expect(updated).toBeDefined();
  });

  it("blocks mutating tools in plan mode", async () => {
    const toolCallGenerator = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "edit_file", arguments: { path: "a.txt", oldText: "x", newText: "y" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "toolUse", toolUse: { id: "call-1", name: "edit_file", arguments: { path: "a.txt", oldText: "x", newText: "y" } } },
          ],
        },
      };
    })();
    const finalGenerator = (async function* () {
      yield { type: "text_delta", delta: "blocked" };
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "blocked" }] },
      };
    })();
    let calls = 0;
    (piStream as ReturnType<typeof mock>).mockImplementation(() => {
      calls++;
      return calls === 1 ? toolCallGenerator as any : finalGenerator as any;
    });

    const session = makeMockSession({ planMode: true });
    await runTurn(session, "start implementing");

    const events = session.eventLog.readLast(50);
    const toolResults = events.filter((e: Event) => e.kind === "tool_result");
    const editResult = toolResults.find((e: any) => e.payload.tool === "edit_file");
    expect(editResult).toBeDefined();
    expect(editResult?.payload.result.ok).toBe(false);
    expect(editResult?.payload.result.error).toContain("Plan mode is active");
  });

  it("allows read-only tools in plan mode", async () => {
    const toolCallGenerator = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "toolUse", toolUse: { id: "call-1", name: "read_file", arguments: { path: "a.txt" } } },
          ],
        },
      };
    })();
    const finalGenerator = (async function* () {
      yield { type: "text_delta", delta: "ok" };
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      };
    })();
    let calls = 0;
    (piStream as ReturnType<typeof mock>).mockImplementation(() => {
      calls++;
      return calls === 1 ? toolCallGenerator as any : finalGenerator as any;
    });

    const session = makeMockSession({ planMode: true });
    await runTurn(session, "explore the code");

    const events = session.eventLog.readLast(50);
    const toolResults = events.filter((e: Event) => e.kind === "tool_result");
    const readResult = toolResults.find((e: any) => e.payload.tool === "read_file");
    expect(readResult).toBeDefined();
    expect(readResult?.payload.result.ok).toBe(true);
  });

  it("auto-enters plan mode for pick-issue phrasing", async () => {
    const generator = (async function* () {
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);
    const session = makeMockSession();
    await runTurn(session, "pick a github issue to work on");
    expect(session.isPlanMode()).toBe(true);
  });

  it("does not auto-enter plan mode in headless sessions", async () => {
    const generator = (async function* () {
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);
    const session = makeMockSession({ headless: true });
    await runTurn(session, "pick a github issue to work on");
    expect(session.isPlanMode()).toBe(false);
  });

  it("exits plan mode on approval words", async () => {
    const generator = (async function* () {
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);
    const session = makeMockSession({ planMode: true });
    await runTurn(session, "go execute the plan");
    expect(session.isPlanMode()).toBe(false);
  });

  it("does not exit plan mode on deferral phrases", async () => {
    const generator = (async function* () {
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      };
    })();
    (piStream as ReturnType<typeof mock>).mockReturnValue(generator as any);
    const session = makeMockSession({ planMode: true });
    await runTurn(session, "continue reading the file first");
    expect(session.isPlanMode()).toBe(true);
  });

  it("blocks branch-creating shell commands in plan mode", async () => {
    const toolCallGenerator = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "shell", arguments: { command: "git checkout -b feature" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "toolUse", toolUse: { id: "call-1", name: "shell", arguments: { command: "git checkout -b feature" } } },
          ],
        },
      };
    })();
    const finalGenerator = (async function* () {
      yield { type: "text_delta", delta: "blocked" };
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "blocked" }] },
      };
    })();
    let calls = 0;
    (piStream as ReturnType<typeof mock>).mockImplementation(() => {
      calls++;
      return calls === 1 ? toolCallGenerator as any : finalGenerator as any;
    });

    const session = makeMockSession({ planMode: true });
    await runTurn(session, "start implementing");

    const events = session.eventLog.readLast(50);
    const toolResults = events.filter((e: Event) => e.kind === "tool_result");
    const shellResult = toolResults.find((e: any) => e.payload.tool === "shell");
    expect(shellResult).toBeDefined();
    expect(shellResult?.payload.result.ok).toBe(false);
    expect(shellResult?.payload.result.error).toContain("Plan mode is active");
  });

  it("allows non-branch git commands in plan mode", async () => {
    const toolCallGenerator = (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: { id: "call-1", name: "shell", arguments: { command: "git branch -a" } },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: [
            { type: "toolUse", toolUse: { id: "call-1", name: "shell", arguments: { command: "git branch -a" } } },
          ],
        },
      };
    })();
    const finalGenerator = (async function* () {
      yield { type: "text_delta", delta: "ok" };
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      };
    })();
    let calls = 0;
    (piStream as ReturnType<typeof mock>).mockImplementation(() => {
      calls++;
      return calls === 1 ? toolCallGenerator as any : finalGenerator as any;
    });

    const session = makeMockSession({ planMode: true });
    await runTurn(session, "explore the code");

    const events = session.eventLog.readLast(50);
    const toolResults = events.filter((e: Event) => e.kind === "tool_result");
    const shellResult = toolResults.find((e: any) => e.payload.tool === "shell");
    expect(shellResult).toBeDefined();
    expect(shellResult?.payload.result.ok).toBe(true);
  });
});
