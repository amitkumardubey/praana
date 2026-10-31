import { describe, it, expect, beforeEach, afterAll, afterEach, mock } from "bun:test";
import { z } from "zod";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNullScorecard } from "../src/context-engine/telemetry.js";
import * as contextEngineActual from "../src/context-engine/index.js";
import * as compileClassicActual from "../src/compile-classic.js";
import * as llmActual from "../src/llm.js";
import * as toolsActual from "../src/tools/index.js";
import * as autoCompactActual from "../src/auto-compact.js";
import * as uiActual from "../src/ui.js";
import * as nativeLlmActual from "../src/llm/index.js";
import * as loggerActual from "../src/logger.js";
import type { PraanaConfig, TurnConfig } from "../src/types.js";
import type { ConversationMessage, StreamRequest } from "../src/llm/types.js";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";

// Snapshot real exports BEFORE mock.module updates live bindings on the namespaces
const ceReal = { ...contextEngineActual };
const ccReal = { ...compileClassicActual };
const llmReal = { ...llmActual };
const toolsReal = { ...toolsActual };
const autoCompactReal = { ...autoCompactActual };
const uiReal = { ...uiActual };
const nativeLlmReal = { ...nativeLlmActual };

const mockStream = mock();

/** Warn calls made by the per-turn llm logger (wrap-up failures). */
const llmWarns: Array<{ message: string; opts?: { details?: Record<string, unknown> } }> = [];

// Capture the real function before mock.module replaces the live binding.
const realCreateSessionLogger = loggerActual.createSessionLogger;

mock.module("../src/logger.js", () => ({
  ...loggerActual,
  createSessionLogger: async (opts: {
    sessionId: string;
    sessionLogDir: string;
    debug?: boolean;
    captureNotice?: (line: string) => void;
    suppressStderr?: boolean;
  }) => {
    const logger = await realCreateSessionLogger(opts);
    const realChild = logger.child.bind(logger);
    logger.child = ((domain: Parameters<typeof logger.child>[0]) => {
      const child = realChild(domain);
      const realWarn = child.warn.bind(child);
      child.warn = (message: string, warnOpts?: { details?: Record<string, unknown> }) => {
        if (domain === "llm") llmWarns.push({ message, opts: warnOpts });
        return realWarn(message, warnOpts);
      };
      return child;
    }) as typeof logger.child;
    return logger;
  },
}));

mock.module("../src/llm/index.js", () => ({
  ...nativeLlmActual,
  streamLlmResponse: mockStream,
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
    shell: {
      description: "Execute a shell command",
      parameters: z.object({ command: z.string() }),
      execute: mock().mockResolvedValue({ ok: true, stdout: "hello" }),
    },
    read_file: {
      description: "Read a file",
      parameters: z.object({ path: z.string() }),
      execute: mock().mockResolvedValue({ ok: true, content: "file content" }),
    },
  })),
  describeTools: mock(() => [
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

import { runTurn } from "../src/turn.js";
import { createAllTools } from "../src/tools/index.js";
import { TurnAbortedError } from "../src/turn-control.js";
import { loadConfig, getConfigWarnings } from "../src/config.js";
import { StateGraph } from "../src/state-graph.js";
import { EventLog } from "../src/event-log.js";
import { createBuiltinHookRegistry } from "../src/hooks/index.js";
import { LoopGate } from "../src/circuit/loop-gate.js";
import type { TurnUiSink } from "../src/ui-events.js";

afterAll(() => {
  mock.module("../src/context-engine/index.js", () => ceReal);
  mock.module("../src/compile-classic.js", () => ccReal);
  mock.module("../src/llm.js", () => llmReal);
  mock.module("../src/tools/index.js", () => toolsReal);
  mock.module("../src/auto-compact.js", () => autoCompactReal);
  mock.module("../src/ui.js", () => uiReal);
  mock.module("../src/llm/index.js", () => nativeLlmReal);
  mock.module("../src/logger.js", () => loggerActual);
  mock.module("../src/compiler.js", () => ({}));
});

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
    tiers: { idle_soft_after_turns: 3, idle_hard_after_turns: 6 },
    session: { log_dir: "/tmp/praana-step-budget-test" },
    consolidation: {
      enabled: false,
      promotion_threshold: 3,
      run_delay_seconds: 30,
    },
    shell: { enabled: false, allowed_paths: [] },
    edit: { confirm: false },
    skills: {
      enabled: false,
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
    project_detection: { enabled: false },
    turn: {
      max_steps: 25,
      pause_after_steps: 50,
      hard_max_steps: 300,
    },
    ...overrides,
  };
}

function makeMockSession(overrides?: Partial<Record<string, any>>) {
  const config = makeConfig();
  const stateGraph = new StateGraph();
  const loopGate = new LoopGate({ threshold: 3 });

  const events: Array<Record<string, unknown>> = [];
  const eventLog = {
    append: mock((ev: Omit<Event, "event_id" | "session_id" | "timestamp">) => {
      const event: any = {
        event_id: `evt-${events.length}`,
        session_id: "test-session",
        timestamp: Date.now(),
        ...ev,
      };
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
    hooks: createBuiltinHookRegistry("/home/test/project", {
      validate: { pathExists: () => true, commandOnPath: () => true },
    }),
    confirmRisk: async () => ({ allowed: true }),
    loopGate,
    observeCircuitPre: (tool: string, args: Record<string, unknown>) =>
      loopGate.observePre(tool, args),
    observeCircuitPost: (tool: string, args: Record<string, unknown>, isError: boolean) =>
      loopGate.observePost(tool, args, isError),
    circuitNotes: () => loopGate.notes(),
    getStartedAt: () => Date.now() - 1_000,
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
    promptDir: "/tmp/praana-step-budget-test/prompts",
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

// ── Fake LLM stream ────────────────────────────────────────────────

interface FakeStreamRequest {
  messages: Array<{
    role: string;
    content?: unknown;
    toolCallId?: string;
    toolName?: string;
    result?: unknown;
    isError?: boolean;
    toolCalls?: Array<{ id: string; name: string; args?: Record<string, unknown> }>;
  }>;
  tools?: Array<{ name: string }>;
}

const NOT_EXECUTED =
  "Not executed: the step budget was reached and the turn was stopped.";

interface LoopStreamOpts {
  failWrapUp?: boolean;
  /** Put toolCalls on the assistant message, as the real drivers do. */
  withToolCalls?: boolean;
  wrapUp?: "summary" | "error" | "interrupt" | "tools";
  abort?: AbortController;
}

/** Stream that requests `loop` tool calls, then answers. */
function makeLoopStream(req: FakeStreamRequest, loop: number, opts?: LoopStreamOpts) {
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const lastUserText =
    typeof lastUser?.content === "string" ? lastUser.content : "";
  const isWrapUpRequest = lastUserText.includes("Do not call tools");
  const toolResultsSoFar = req.messages.filter((m) => m.role === "tool_result").length;

  if (isWrapUpRequest) {
    if (opts?.failWrapUp) {
      return (async function* () {
        throw new Error("wrap-up provider failure");
      })();
    }
    if (opts?.wrapUp === "error") {
      return (async function* () {
        yield {
          type: "error",
          error: new Error("wrap-up provider 500"),
          retryable: false,
        };
      })();
    }
    if (opts?.wrapUp === "interrupt") {
      return (async function* () {
        yield { type: "text_delta", delta: "partial wrap" };
        opts.abort?.abort();
        yield { type: "text_delta", delta: " tail" };
      })();
    }
    if (opts?.wrapUp === "tools") {
      return (async function* () {
        yield { type: "text_delta", delta: "[summary] wrapped up" };
        yield {
          type: "toolcall_end",
          toolCall: {
            id: "wrap-call",
            name: "shell",
            arguments: { command: "echo should-not-run" },
          },
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: "[summary] wrapped up",
            toolCalls: [
              { id: "wrap-call", name: "shell", args: { command: "echo should-not-run" } },
            ],
          },
        };
      })();
    }
    return (async function* () {
      yield { type: "text_delta", delta: "[summary] wrapped up" };
      yield {
        type: "done",
        reason: "stop",
        message: { role: "assistant", content: "[summary] wrapped up" },
      };
    })();
  }

  if (toolResultsSoFar < loop) {
    const id = `call-${toolResultsSoFar}`;
    const toolCalls = opts?.withToolCalls
      ? [{ id, name: "shell", args: { command: `echo ${id}` } }]
      : undefined;
    return (async function* () {
      yield {
        type: "toolcall_end",
        toolCall: {
          id,
          name: "shell",
          arguments: { command: `echo ${id}` },
        },
      };
      yield {
        type: "done",
        reason: "toolUse",
        message: {
          role: "assistant",
          content: toolCalls ? "" : [],
          ...(toolCalls ? { toolCalls } : {}),
        },
      };
    })();
  }

  return (async function* () {
    yield { type: "text_delta", delta: "final answer reached" };
    yield {
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "final answer reached" },
    };
  })();
}

function installLoopStream(loop: number, opts?: LoopStreamOpts) {
  (mockStream as ReturnType<typeof mock>).mockImplementation((req: FakeStreamRequest) => {
    return makeLoopStream(req, loop, opts);
  });
}

function shellExecuteCount(): number {
  const fn = createAllTools as unknown as {
    mock: {
      results: Array<{
        value?: { shell?: { execute?: { mock?: { calls: unknown[] } } } };
      }>;
    };
  };
  return fn.mock.results.at(-1)?.value?.shell?.execute?.mock?.calls.length ?? -1;
}

function makePauseSink() {
  const pauseCalls: number[] = [];
  let pauseAnswer = true;
  const sink: TurnUiSink & {
    pauseCalls: number[];
    texts: string[];
    sys: string[];
    setPauseAnswer: (v: boolean) => void;
  } = {
    pauseCalls,
    texts: [],
    sys: [],
    setPauseAnswer(v: boolean) {
      pauseAnswer = v;
    },
    onTextDelta: (d: string) => {
      sink.texts.push(d);
    },
    onSystemLines: (lines: string[]) => {
      sink.sys.push(...lines);
    },
    onStepPause: async (n: number) => {
      pauseCalls.push(n);
      return pauseAnswer;
    },
  };
  return sink;
}

function streamRequestCalls(): Array<{ messages: FakeStreamRequest["messages"] }> {
  return ((mockStream as ReturnType<typeof mock>).mock.calls as Array<[FakeStreamRequest]>).map(
    (c) => c[0],
  );
}

function toolResultsBeforeCall(callIndex: number): number {
  const req = streamRequestCalls()[callIndex];
  if (!req) return -1;
  return req.messages.filter((m) => m.role === "tool_result").length;
}

/**
 * Feed canonical history through a real provider driver (fetch mocked) and
 * return the JSON body the driver would POST. No network.
 */
async function captureDriverBody(
  driver: AnthropicDriver | OpenAICompatibleDriver,
  messages: ConversationMessage[],
): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let body: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const stream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  try {
    const req: StreamRequest = {
      model: "test-model",
      provider: "test",
      messages,
      tools: [],
    };
    for await (const _event of driver.stream(req, { apiKey: "test-key" })) {
      // Body is captured when fetch runs, before events are yielded.
    }
  } finally {
    globalThis.fetch = original;
  }
  if (!body) throw new Error("driver did not serialize a request body");
  return body;
}

function toolUseIds(body: Record<string, unknown>, protocol: "anthropic" | "openai"): string[] {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const ids: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const record = msg as Record<string, unknown>;
    if (protocol === "openai" && Array.isArray(record.tool_calls)) {
      for (const tc of record.tool_calls) {
        if (tc && typeof tc === "object" && typeof (tc as { id?: unknown }).id === "string") {
          ids.push((tc as { id: string }).id);
        }
      }
    }
    if (!Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (!part || typeof part !== "object") continue;
      const block = part as { type?: unknown; id?: unknown };
      if (protocol === "anthropic" && block.type === "tool_use" && typeof block.id === "string") {
        ids.push(block.id);
      }
    }
  }
  return ids;
}

function toolResultIds(body: Record<string, unknown>, protocol: "anthropic" | "openai"): Set<string> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const ids = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const record = msg as Record<string, unknown>;
    if (protocol === "openai" && record.role === "tool" && typeof record.tool_call_id === "string") {
      ids.add(record.tool_call_id);
    }
    if (!Array.isArray(record.content)) continue;
    for (const part of record.content) {
      if (!part || typeof part !== "object") continue;
      const block = part as { type?: unknown; tool_use_id?: unknown };
      if (
        protocol === "anthropic" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        ids.add(block.tool_use_id);
      }
    }
  }
  return ids;
}

/** Every tool_use / tool_calls id in a serialized provider payload has a result. */
async function expectEveryToolCallHasResult(messages: ConversationMessage[]): Promise<void> {
  const anthropic = await captureDriverBody(new AnthropicDriver(), messages);
  const openai = await captureDriverBody(new OpenAICompatibleDriver(), messages);
  for (const [protocol, body] of [
    ["anthropic", anthropic],
    ["openai", openai],
  ] as const) {
    const used = toolUseIds(body, protocol);
    const resolved = toolResultIds(body, protocol);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((id) => !resolved.has(id))).toEqual([]);
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("per-turn step budget — interactive soft pause", () => {
  beforeEach(() => {
    (mockStream as ReturnType<typeof mock>).mockReset();
  });

  it("pause fires after N steps and not before; continue carries on and pauses again after another N", async () => {
    installLoopStream(7);
    const session = makeMockSession({
      config: makeConfig({
        turn: {
          max_steps: 25,
          pause_after_steps: 3,
          hard_max_steps: 300,
        },
      }),
    });
    const sink = makePauseSink();
    sink.setPauseAnswer(true);

    const response = await runTurn(session, "loop 7", undefined, { sink });

    // Pauses occurred at steps 3 and 6 — not at 1, 2, 4, 5.
    expect(sink.pauseCalls).toEqual([3, 6]);
    // 7 tool rounds + 1 final answer = 8 stream calls.
    expect(streamRequestCalls().length).toBe(8);
    expect(response).toContain("final answer reached");
  });

  it("stop at the pause resolves to a wrap-up stream call and no further tool execution", async () => {
    installLoopStream(6);
    const session = makeMockSession({
      config: makeConfig({
        turn: {
          max_steps: 25,
          pause_after_steps: 3,
          hard_max_steps: 300,
        },
      }),
    });
    const sink = makePauseSink();
    sink.setPauseAnswer(false);

    const response = await runTurn(session, "loop 6", undefined, { sink });

    expect(sink.pauseCalls).toEqual([3]);
    // 3 tool rounds + 1 wrap-up call = 4 stream calls. No further tool rounds.
    expect(streamRequestCalls().length).toBe(4);
    // Rounds 1 and 2 ran. The batch requested at the pause was not executed;
    // it is recorded as one error result so the wrap-up history stays valid.
    const lastReq = streamRequestCalls().at(-1)!;
    const toolResults = lastReq.messages.filter((m) => m.role === "tool_result");
    expect(toolResults).toHaveLength(3);
    expect(
      toolResults.filter((m) => String(m.result ?? "").includes(NOT_EXECUTED)),
    ).toHaveLength(1);
    // The wrap-up request is a user instruction asking for a summary.
    const lastUser = [...lastReq.messages].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content ?? "")).toContain("Do not call tools");
    // The wrap-up summary streams like a normal reply.
    expect(response).toContain("[summary] wrapped up");
    expect(sink.texts.join("")).toContain("[summary] wrapped up");
  });

  it("hard ceiling forces the wrap-up without prompting", async () => {
    installLoopStream(10);
    const session = makeMockSession({
      config: makeConfig({
        turn: {
          max_steps: 25,
          pause_after_steps: 100,
          hard_max_steps: 3,
        },
      }),
    });
    const sink = makePauseSink();

    const response = await runTurn(session, "loop 10", undefined, { sink });

    expect(sink.pauseCalls).toEqual([]);
    // 3 tool rounds then wrap-up: no prompting, no extra tool rounds.
    expect(streamRequestCalls().length).toBe(4);
    const lastReq = streamRequestCalls().at(-1)!;
    const ceilingResults = lastReq.messages.filter((m) => m.role === "tool_result");
    expect(ceilingResults).toHaveLength(3);
    expect(
      ceilingResults.filter((m) => String(m.result ?? "").includes(NOT_EXECUTED)),
    ).toHaveLength(1);
    expect(response).toContain("[summary] wrapped up");
  });

  it("if the wrap-up call fails, the turn ends with the existing banner text, not an exception", async () => {
    installLoopStream(6, { failWrapUp: true });
    const session = makeMockSession({
      config: makeConfig({
        turn: {
          max_steps: 25,
          pause_after_steps: 3,
          hard_max_steps: 300,
        },
      }),
    });
    const sink = makePauseSink();
    sink.setPauseAnswer(false);

    // Must not reject.
    const response = await runTurn(session, "loop 6", undefined, { sink });

    expect(typeof response).toBe("string");
    expect(sink.pauseCalls).toEqual([3]);
    // No summary text; falls back to the existing empty-response banner.
    expect(response).not.toContain("[summary]");
  });

  it("stop and hard ceiling serialize every pending tool call id with a result", async () => {
    const stopAt = async (kind: "pause" | "ceiling") => {
      installLoopStream(6, { withToolCalls: true });
      const session = makeMockSession({
        config: makeConfig({
          turn: {
            max_steps: 25,
            pause_after_steps: kind === "pause" ? 3 : 100,
            hard_max_steps: kind === "ceiling" ? 3 : 300,
          },
        }),
      });
      const sink = makePauseSink();
      sink.setPauseAnswer(false);
      await runTurn(session, `loop ${kind}`, undefined, { sink });
      // The stopped batch was not executed.
      expect(shellExecuteCount()).toBe(2);
      const last = streamRequestCalls().at(-1)!;
      // Prove the wrap-up payload through the real Anthropic and OpenAI
      // serializers before checking the synthetic result text.
      await expectEveryToolCallHasResult(last.messages as ConversationMessage[]);
      const synthetic = last.messages.filter(
        (m) => m.role === "tool_result" && String(m.result ?? "").includes(NOT_EXECUTED),
      );
      expect(synthetic).toHaveLength(1);
      expect(synthetic[0]?.isError).toBe(true);
    };

    await stopAt("pause");
    await stopAt("ceiling");
  });

  it("Ctrl+C during wrap-up finalizes the turn as an interrupt", async () => {
    const abort = new AbortController();
    installLoopStream(6, { wrapUp: "interrupt", abort });
    const session = makeMockSession({
      config: makeConfig({
        turn: { max_steps: 25, pause_after_steps: 3, hard_max_steps: 300 },
      }),
    });
    const sink = makePauseSink();
    sink.setPauseAnswer(false);

    let thrown: unknown;
    try {
      await runTurn(session, "interrupt wrap", undefined, { sink, signal: abort.signal });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnAbortedError);
    expect((thrown as TurnAbortedError).partialResponse).toContain("partial wrap");
  });

  it("a wrap-up stream error is logged and shown as the end-of-turn banner", async () => {
    llmWarns.length = 0;
    installLoopStream(6, { wrapUp: "error" });
    const session = makeMockSession({
      config: makeConfig({
        turn: { max_steps: 25, pause_after_steps: 3, hard_max_steps: 300 },
      }),
    });
    const sink = makePauseSink();
    sink.setPauseAnswer(false);
    const fallbacks: string[] = [];
    sink.onFallback = (text: string) => {
      fallbacks.push(text);
    };

    const response = await runTurn(session, "error wrap", undefined, { sink });

    expect(fallbacks.join("\n")).toContain("[LLM error: wrap-up provider 500]");
    expect(response).toContain("I encountered an error while processing your request.");
    const logged = llmWarns.find((w) => w.message.toLowerCase().includes("wrap-up"));
    expect(logged).toBeDefined();
    expect(logged?.opts?.details?.error).toBe("wrap-up provider 500");
    expect(logged?.opts?.details?.model).toBe("test-model");
    expect(logged?.opts?.details?.provider).toBe("openrouter");
  });

  it("wrap-up offers no tools and does not run tool calls from that reply", async () => {
    installLoopStream(6, { wrapUp: "tools" });
    const session = makeMockSession({
      config: makeConfig({
        turn: { max_steps: 25, pause_after_steps: 3, hard_max_steps: 300 },
      }),
    });
    const sink = makePauseSink();
    sink.setPauseAnswer(false);

    const response = await runTurn(session, "tools wrap", undefined, { sink });

    const calls = streamRequestCalls();
    const wrap = calls.at(-1)!;
    expect(wrap.tools ?? []).toEqual([]);
    expect(calls).toHaveLength(4);
    expect(shellExecuteCount()).toBe(2);
    expect(response).toContain("[summary] wrapped up");
    const sawWrapCall = calls.some((req) =>
      req.messages.some(
        (m) =>
          m.role === "assistant" &&
          (m.toolCalls ?? []).some((tc) => tc.id === "wrap-call"),
      ),
    );
    expect(sawWrapCall).toBe(false);
  });
});

describe("per-turn step budget — headless hard cap", () => {
  beforeEach(() => {
    (mockStream as ReturnType<typeof mock>).mockReset();
  });

  it("headless max_steps cap performs a wrap-up and never prompts", async () => {
    installLoopStream(6);
    const session = makeMockSession({
      headless: true,
      config: makeConfig({
        turn: {
          max_steps: 3,
          pause_after_steps: 2,
          hard_max_steps: 300,
        },
      }),
    });
    const sink = makePauseSink();

    const response = await runTurn(session, "loop 6", undefined, { sink });

    // Never prompted, even though steps reached a multiple of pause_after_steps.
    expect(sink.pauseCalls).toEqual([]);
    // 3 tool rounds + 1 wrap-up call = 4 stream calls.
    expect(streamRequestCalls().length).toBe(4);
    // The last executed batch (round 3) results ARE in history before the
    // wrap-up call.
    const lastReq = streamRequestCalls().at(-1)!;
    const toolResults = lastReq.messages.filter((m) => m.role === "tool_result");
    expect(toolResults.length).toBe(3);
    const lastUser = [...lastReq.messages].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content ?? "")).toContain("Do not call tools");
    expect(response).toContain("[summary] wrapped up");
  });

  it("non-TTY / sink without a pause hook never prompts", async () => {
    installLoopStream(4);
    const session = makeMockSession({
      config: makeConfig({
        turn: {
          max_steps: 25,
          pause_after_steps: 2,
          hard_max_steps: 300,
        },
      }),
    });
    const sink: TurnUiSink = {
      onTextDelta: () => {},
      onSystemLines: () => {},
    };

    const response = await runTurn(session, "loop 4", undefined, { sink });

    // 4 tool rounds + 1 answer = 5 stream calls, no pauses in between.
    expect(streamRequestCalls().length).toBe(5);
    expect(response).toContain("final answer reached");
  });

  it("a sink without onStepPause uses max_steps as a hard cap with wrap-up", async () => {
    installLoopStream(6);
    const session = makeMockSession({
      config: makeConfig({
        turn: { max_steps: 3, pause_after_steps: 2, hard_max_steps: 300 },
      }),
    });
    const sink: TurnUiSink = { onTextDelta: () => {}, onSystemLines: () => {} };

    const response = await runTurn(session, "no hook", undefined, { sink });

    expect(streamRequestCalls().length).toBe(4);
    const last = streamRequestCalls().at(-1)!;
    expect(last.messages.filter((m) => m.role === "tool_result")).toHaveLength(3);
    expect(
      last.messages.some((m) => String(m.result ?? "").includes(NOT_EXECUTED)),
    ).toBe(false);
    const lastUser = [...last.messages].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content ?? "")).toContain("Do not call tools");
    expect(response).toContain("[summary] wrapped up");
    expect(shellExecuteCount()).toBe(3);
  });

  it("a sink with onStepPause keeps going past max_steps until the pause or ceiling", async () => {
    installLoopStream(4);
    const session = makeMockSession({
      config: makeConfig({
        turn: { max_steps: 2, pause_after_steps: 100, hard_max_steps: 10 },
      }),
    });
    const sink = makePauseSink();
    sink.setPauseAnswer(true);

    const response = await runTurn(session, "hook ignores max_steps", undefined, { sink });

    expect(sink.pauseCalls).toEqual([]);
    expect(streamRequestCalls().length).toBe(5);
    expect(response).toContain("final answer reached");
    expect(shellExecuteCount()).toBe(4);
  });
});

describe("per-turn step budget — config validation", () => {
  let root: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "praana-step-budget-"));
    mkdirSync(join(root, ".praana"), { recursive: true });
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = root;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function writeTurnConfig(content: string) {
    writeFileSync(join(root, ".praana", "config.toml"), content, "utf-8");
  }

  it("defaults to max_steps=25, pause_after_steps=50, hard_max_steps=300", () => {
    writeTurnConfig("# empty\n");
    const config = loadConfig();
    const t = config.turn as TurnConfig;
    expect(t.max_steps).toBe(25);
    expect(t.pause_after_steps).toBe(50);
    expect(t.hard_max_steps).toBe(300);
    expect(getConfigWarnings()).toHaveLength(0);
  });

  it("accepts valid overrides", () => {
    writeTurnConfig(
      "[turn]\nmax_steps = 10\npause_after_steps = 7\nhard_max_steps = 99\n",
    );
    const config = loadConfig();
    const t = config.turn as TurnConfig;
    expect(t.max_steps).toBe(10);
    expect(t.pause_after_steps).toBe(7);
    expect(t.hard_max_steps).toBe(99);
    expect(getConfigWarnings()).toHaveLength(0);
  });

  it("invalid/zero values fall back to defaults and warn", () => {
    writeTurnConfig(
      "[turn]\nmax_steps = 0\npause_after_steps = -5\nhard_max_steps = 0\n",
    );
    const config = loadConfig();
    const t = config.turn as TurnConfig;
    expect(t.max_steps).toBe(25);
    expect(t.pause_after_steps).toBe(50);
    expect(t.hard_max_steps).toBe(300);
    const warnings = getConfigWarnings();
    expect(warnings.some((w) => w.includes("turn.max_steps"))).toBe(true);
    expect(warnings.some((w) => w.includes("turn.pause_after_steps"))).toBe(true);
    expect(warnings.some((w) => w.includes("turn.hard_max_steps"))).toBe(true);
  });

  it("raises hard_max_steps to pause_after_steps when the ceiling is lower", () => {
    writeTurnConfig("[turn]\npause_after_steps = 40\nhard_max_steps = 10\n");
    const config = loadConfig();
    const t = config.turn as TurnConfig;
    expect(t.pause_after_steps).toBe(40);
    expect(t.hard_max_steps).toBe(40);
    const warnings = getConfigWarnings();
    expect(
      warnings.some(
        (w) => w.includes("hard_max_steps") && w.includes("pause_after_steps"),
      ),
    ).toBe(true);
  });
});
