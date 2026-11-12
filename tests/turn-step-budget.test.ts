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
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
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

import { flattenWrapUpHistory, WRAP_UP_TOOL_RESULT_CAP, runTurn } from "../src/turn.js";
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
    const toolCalls = opts?.withToolCalls !== false
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

/** Arrays that are a turn's live history (the opening user message carries a timestamp). */
async function historyArraysFor(userInput: string, run: () => Promise<unknown>): Promise<any[][]> {
  const found: any[][] = [];
  const original = Array.prototype.push;
  Array.prototype.push = function (...items: any[]) {
    const ret = original.apply(this, items);
    const first = this[0] as { role?: string; content?: unknown; timestamp?: unknown } | undefined;
    if (first?.role === "user" && first.content === userInput && typeof first.timestamp === "number") {
      found.push(this);
    }
    return ret;
  };
  try {
    await run();
  } finally {
    Array.prototype.push = original;
  }
  return [...new Set(found)];
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
  driver: AnthropicDriver | OpenAICompatibleDriver | BedrockDriver | GoogleDriver,
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

const WRAP_DRIVERS = [
  ["Anthropic", new AnthropicDriver()],
  ["Bedrock", new BedrockDriver()],
  ["OpenAI", new OpenAICompatibleDriver()],
  ["Google", new GoogleDriver()],
] as const;

function providerMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = body.messages ?? body.contents;
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
}

function assertAlternatingRoles(messages: Array<Record<string, unknown>>): void {
  let prev = "";
  for (const msg of messages) {
    const role = String(msg.role ?? "");
    expect(role).not.toBe("");
    expect(role).not.toBe(prev);
    prev = role;
  }
}

describe("wrap-up provider request shapes", () => {
  for (const [name, driver] of WRAP_DRIVERS) {
    it(`${name} wrap-up sends no tool blocks without definitions`, async () => {
      mockStream.mockReset();
      installLoopStream(5, { withToolCalls: true });
      const session = makeMockSession({ config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }), headless: true });
      await runTurn(session, "loop", undefined, { sink: {} });
      const req = (mockStream.mock.calls as unknown as Array<[StreamRequest]>).at(-1)![0];
      expect(req.tools).toEqual([]);
      const body = await captureDriverBody(driver, req.messages);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('"type":"tool_use"');
      expect(serialized).not.toContain('"type":"tool_result"');
      expect(serialized).not.toContain('"toolUse":');
      expect(serialized).not.toContain('"toolResult":');
      expect(serialized).not.toContain('"tool_calls"');
      expect(serialized).not.toContain('"functionCall"');
      expect(serialized).not.toContain('"functionResponse"');
      expect(serialized).toContain("echo call-0");
      assertAlternatingRoles(providerMessages(body));
    });
  }

  it("keeps text parts only, truncates, and merges adjacent user messages", async () => {
    const long = "v".repeat(WRAP_UP_TOOL_RESULT_CAP + 50);
    const flat = flattenWrapUpHistory([
      { role: "user", content: "do the work", timestamp: 1 },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-img", name: "shell", args: { command: "echo call-img" } }],
      },
      {
        role: "toolResult",
        toolName: "shell",
        toolCallId: "call-img",
        content: [
          { type: "text", text: long },
          { type: "image", mimeType: "image/png", data: "BASE64SENTINEL" },
        ],
      },
      {
        role: "user",
        content: "Stopped. Reply with a short summary of what was done and what remains. Do not call tools.",
        timestamp: 2,
      },
    ]);
    const merged = flat.filter((m) => m.role === "user").at(-1);
    expect(String(merged?.content)).toContain("[truncated]");
    expect(String(merged?.content)).toContain("Do not call tools");
    expect(String(merged?.content)).not.toContain("BASE64SENTINEL");
    expect(String(merged?.content).match(/v+/)?.[0]?.length).toBe(
      WRAP_UP_TOOL_RESULT_CAP - "[truncated]".length,
    );
    for (const [, driver] of WRAP_DRIVERS) {
      const body = await captureDriverBody(driver, flat as ConversationMessage[]);
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("BASE64SENTINEL");
      expect(serialized).toContain("[truncated]");
      expect(serialized).toContain("Do not call tools");
      assertAlternatingRoles(providerMessages(body));
    }
  });

  it("caps a 200 KB write_file argument on the wrap-up request", () => {
    const payload = "x".repeat(200_000);
    const flat = flattenWrapUpHistory([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "w1", name: "write_file", args: { path: "a.ts", content: payload } }],
      },
    ]);
    const text = String(flat[0]?.content ?? "");
    expect(text.length).toBeLessThan(WRAP_UP_TOOL_RESULT_CAP + 400);
    expect(text).toContain("write_file");
    expect(text).toContain("w1");
    expect(text).toContain("[truncated]");
    expect(text).not.toContain(payload);
  });
});

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

  it("reports pause stop before even a failed wrap-up", async () => {
    installLoopStream(5, { failWrapUp: true });
    const session = makeMockSession({ config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }) });
    const sink = makePauseSink();
    sink.setPauseAnswer(false);
    await runTurn(session, "pause notice", undefined, { sink });
    expect(sink.sys).toContain("Stopped at the step pause.");
  });

  it("records a successful empty wrap-up as stop rather than toolUse", async () => {
    llmWarns.length = 0;
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = req.messages.at(-1);
      if (String(last?.content ?? "").includes("Do not call tools")) {
        return (async function* () { yield { type: "done", reason: "stop", message: { role: "assistant", content: "" } }; })();
      }
      return makeLoopStream(req, 5);
    });
    const session = makeMockSession({ headless: true, config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }) });
    await runTurn(session, "empty wrap", undefined, { sink: {} });
    expect(llmWarns.find((w) => w.message === "LLM returned no text content")?.opts?.details?.reason).toBe("stop");
  });

  it("reports the headless cap before streaming its wrap-up", async () => {
    installLoopStream(5);
    const session = makeMockSession({ headless: true, config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }) });
    const order: string[] = [];
    await runTurn(session, "limit notice", undefined, { sink: { onSystemLines: (lines) => order.push(...lines), onTextDelta: (text) => order.push(text) } });
    expect(order.indexOf("Reached the step limit (1).")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("Reached the step limit (1).")).toBeLessThan(order.indexOf("[summary] wrapped up"));
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
    const toolResults = lastReq.messages.filter((m) => String(m.content ?? "").startsWith("Tool result ("));
    expect(toolResults).toHaveLength(3);
    expect(toolResults.filter((m) => String(m.content ?? "").includes(NOT_EXECUTED))).toHaveLength(1);
    // The wrap-up request is a user instruction asking for a summary.
    const lastUser = [...lastReq.messages].reverse().find((m) => m.role === "user");
    expect(String(lastUser?.content ?? "")).toContain("Do not call tools");
    // The wrap-up summary streams like a normal reply.
    expect(response).toContain("[summary] wrapped up");
    expect(sink.texts.join("")).toContain("[summary] wrapped up");
  });

  it("keeps a directly constructed ceiling that is not above the pause interval and does not ask", async () => {
    llmWarns.length = 0;
    installLoopStream(10);
    const session = makeMockSession({ config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 4, hard_max_steps: 2 } }) });
    const sink = makePauseSink();
    await runTurn(session, "invalid ceiling", undefined, { sink });
    expect(sink.pauseCalls).toEqual([]);
    expect(streamRequestCalls()).toHaveLength(3);
    expect(shellExecuteCount()).toBe(1);
    expect(llmWarns.some((w) => w.message.includes("hard_max_steps") && w.message.includes("pause_after_steps"))).toBe(false);
  });

  it("clamps NaN, non-integer, and negative budgets that reach runTurn directly", async () => {
    llmWarns.length = 0;
    installLoopStream(4);
    const session = makeMockSession({
      config: makeConfig({
        turn: { max_steps: Number.NaN, pause_after_steps: 1.5, hard_max_steps: -3 },
      }),
    });
    const sink = makePauseSink();
    const response = await runTurn(session, "bad numbers", undefined, { sink });
    expect(sink.pauseCalls).toEqual([]);
    expect(streamRequestCalls()).toHaveLength(5);
    expect(response).toContain("final answer reached");
    expect(llmWarns.some((w) => w.message.includes("hard_max_steps") || w.message.includes("pause_after_steps"))).toBe(false);

    installLoopStream(2);
    const headless = makeMockSession({
      headless: true,
      config: makeConfig({
        turn: { max_steps: Number.NaN, pause_after_steps: -8, hard_max_steps: 2.2 },
      }),
    });
    const before = streamRequestCalls().length;
    await runTurn(headless, "nan cap", undefined, { sink: {} });
    expect(streamRequestCalls().length - before).toBe(3);
  });

  it("hard ceiling forces the wrap-up without prompting", async () => {
    installLoopStream(10);
    const session = makeMockSession({
      config: makeConfig({
        turn: {
          max_steps: 25,
          pause_after_steps: 3,
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
    const ceilingResults = lastReq.messages.filter((m) => String(m.content ?? "").startsWith("Tool result ("));
    expect(ceilingResults).toHaveLength(3);
    expect(ceilingResults.filter((m) => String(m.content ?? "").includes(NOT_EXECUTED))).toHaveLength(1);
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

  it("reports a tool-only wrap-up failure with one onError", async () => {
    installLoopStream(1, { failWrapUp: true });
    const session = makeMockSession({
      headless: true,
      config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }),
    });
    const errors: string[] = [];
    await runTurn(session, "tools only", undefined, {
      sink: { onError: (entry) => errors.push(entry.message) },
    });
    expect(errors).toEqual(["wrap-up provider failure"]);
  });

  it("does not show or count a final-message summary when the wrap-up errors", async () => {
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : "";
      if (text.includes("Do not call tools")) {
        return (async function* () {
          yield {
            type: "done",
            reason: "error",
            message: { role: "assistant", content: `hidden summary ${"y".repeat(80)}` },
          };
        })();
      }
      return (async function* () {
        yield {
          type: "toolcall_end",
          toolCall: { id: "call-0", name: "shell", arguments: { command: "echo call-0" } },
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-0", name: "shell", args: { command: "echo call-0" } }],
          },
        };
      })();
    });
    const session = makeMockSession({
      config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }),
    });
    const texts: string[] = [];
    const errors: string[] = [];
    let wrapTokens = 0;
    let wrapStarted = false;
    const seen = mockStream.getMockImplementation();
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : "";
      if (text.includes("Do not call tools")) wrapStarted = true;
      return seen?.(req);
    });
    const response = await runTurn(session, "error keeps message", undefined, {
      sink: {
        onStepPause: () => false,
        onTextDelta: (delta) => texts.push(delta),
        onFallback: (text) => texts.push(text),
        onError: (entry) => errors.push(entry.message),
        onContextHistoryDelta: (delta) => {
          if (wrapStarted && delta.source === "assistant") wrapTokens += delta.tokensAdded;
        },
      },
    });
    expect(texts.join("")).not.toContain("hidden summary");
    expect(response).not.toContain("hidden summary");
    expect(errors.length + texts.filter((line) => line.includes("LLM")).length).toBeGreaterThan(0);
    expect(wrapTokens).toBe(0);
    const agent = String(
      session.eventLog.readAll().filter((e: { kind?: string }) => e.kind === "agent_message").at(-1)?.payload?.text ?? "",
    );
    expect(agent).not.toContain("hidden summary");
  });

  it("does not count tokens for an aborted wrap-up with no visible text", async () => {
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : "";
      if (text.includes("Do not call tools")) {
        return (async function* () {
          yield {
            type: "done",
            reason: "aborted",
            message: { role: "assistant", content: "   ", thinking: `secret ${"z".repeat(40)}` },
          };
        })();
      }
      return makeLoopStream(req, 1);
    });
    const session = makeMockSession({
      headless: true,
      config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }),
    });
    let wrapTokens = 0;
    let wrapStarted = false;
    const seen = mockStream.getMockImplementation();
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : "";
      if (text.includes("Do not call tools")) wrapStarted = true;
      return seen?.(req);
    });
    let thrown: unknown;
    try {
      await runTurn(session, "abort blank wrap", undefined, {
        sink: {
          onTextDelta: () => {},
          onContextHistoryDelta: (delta) => {
            if (wrapStarted && delta.source === "assistant") wrapTokens += delta.tokensAdded;
          },
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnAbortedError);
    expect(wrapTokens).toBe(0);
    expect(String((thrown as TurnAbortedError).partialResponse)).not.toContain("secret");
  });

  it("adds wrap-up assistant tokens when the summary is aborted", async () => {
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : "";
      if (text.includes("Do not call tools")) {
        const body = `partial wrap ${"x".repeat(40)}`;
        return (async function* () {
          yield { type: "done", reason: "aborted", message: { role: "assistant", content: body } };
        })();
      }
      return makeLoopStream(req, 1);
    });
    const session = makeMockSession({
      headless: true,
      config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }),
    });
    const added: number[] = [];
    let thrown: unknown;
    try {
      await runTurn(session, "abort wrap", undefined, {
        sink: {
          onContextHistoryDelta: (delta) => {
            if (delta.source === "assistant") added.push(delta.tokensAdded);
          },
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnAbortedError);
    expect(added.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
  });

  it("sends a final-message wrap-up through onTextDelta with a separator", async () => {
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : "";
      if (text.includes("Do not call tools")) {
        return (async function* () {
          yield { type: "done", reason: "stop", message: { role: "assistant", content: "summary from message" } };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "did the work" };
        yield {
          type: "toolcall_end",
          toolCall: { id: "call-0", name: "shell", arguments: { command: "echo call-0" } },
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: "did the work",
            toolCalls: [{ id: "call-0", name: "shell", args: { command: "echo call-0" } }],
          },
        };
      })();
    });
    const session = makeMockSession({
      headless: true,
      config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }),
    });
    const texts: string[] = [];
    await runTurn(session, "no deltas", undefined, {
      sink: { onTextDelta: (delta) => texts.push(delta) },
    });
    const joined = texts.join("");
    expect(joined.indexOf("did the work")).toBeGreaterThanOrEqual(0);
    expect(joined.indexOf("\n\n")).toBeGreaterThan(joined.indexOf("did the work"));
    expect(joined).toContain("summary from message");
  });

  it("emits the debug block for the batch that hits the step cap", async () => {
    installLoopStream(3);
    const session = makeMockSession({
      headless: true,
      debug: true,
      config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }),
    });
    const steps: number[] = [];
    await runTurn(session, "debug cap", undefined, {
      sink: { onDebugBlock: (stepIndex) => steps.push(stepIndex) },
    });
    expect(steps).toEqual([1]);
  });

  it("stop and hard ceiling serialize every pending tool call id with a result", async () => {
    const stopAt = async (kind: "pause" | "ceiling") => {
      installLoopStream(6, { withToolCalls: true });
      const session = makeMockSession({
        config: makeConfig({
          turn: {
            max_steps: 25,
            pause_after_steps: 3,
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
      // Flattened wrap-up history retains the stopped call and its result.
      expect(JSON.stringify(last.messages)).toContain("call-2");
      const synthetic = last.messages.filter((m) => String(m.content ?? "").includes(NOT_EXECUTED));
      expect(synthetic).toHaveLength(1);
    };

    await stopAt("pause");
    await stopAt("ceiling");
  });

  it("treats a throwing pause hook as stop and wraps up", async () => {
    installLoopStream(5);
    const session = makeMockSession({ config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }) });
    const notices: string[] = [];
    const sink: TurnUiSink = {
      onStepPause: () => { throw new Error("pause hook failed"); },
      onSystemLines: (lines) => notices.push(...lines),
    };
    await runTurn(session, "throwing pause", undefined, { sink });
    expect(notices).toContain("Stopped at the step pause.");
    expect(shellExecuteCount()).toBe(0);
  });

  it("I1: aborting a pause aborts the hook's cancellation signal", async () => {
    installLoopStream(5);
    const session = makeMockSession({ config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }) });
    const abort = new AbortController();
    let pauseSignal: AbortSignal | undefined;
    const sink: TurnUiSink = { onStepPause: (_steps: number, signal: AbortSignal) => {
      pauseSignal = signal;
      abort.abort();
      return new Promise<boolean>(() => {});
    } };
    await runTurn(session, "abort pause", undefined, { sink, signal: abort.signal }).catch(() => {});
    expect(pauseSignal?.aborted).toBe(true);
  });

  it("aborting while a pause handler is pending interrupts the turn", async () => {
    installLoopStream(5);
    const session = makeMockSession({ config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }) });
    const abort = new AbortController();
    const sink: TurnUiSink = { onStepPause: () => { abort.abort(); return new Promise<boolean>(() => {}); } };
    const result = await Promise.race([
      runTurn(session, "abort pause", undefined, { sink, signal: abort.signal }).catch((err) => err),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);
    expect(result).toBeInstanceOf(TurnAbortedError);
    expect(shellExecuteCount()).toBe(0);
  });

  function wrapUpCalls(): number {
    return streamRequestCalls().filter((call) =>
      JSON.stringify(call.messages).includes("Do not call tools"),
    ).length;
  }

  it("does not wrap up when the pause resolves false because the turn aborted", async () => {
    installLoopStream(4);
    const session = makeMockSession({
      config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }),
    });
    const abort = new AbortController();
    const before = wrapUpCalls();
    const sink: TurnUiSink = {
      onStepPause: (_steps, signal) => {
        signal.addEventListener("abort", () => {}, { once: true });
        abort.abort();
        return false;
      },
    };
    let thrown: unknown;
    try {
      await runTurn(session, "ctrl+c at pause", undefined, { sink, signal: abort.signal });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnAbortedError);
    expect(wrapUpCalls() - before).toBe(0);
  });

  it("wraps up exactly once when the pause stops without an abort", async () => {
    installLoopStream(4);
    const session = makeMockSession({
      config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }),
    });
    const before = wrapUpCalls();
    await runTurn(session, "esc at pause", undefined, {
      sink: { onStepPause: () => false },
    });
    expect(wrapUpCalls() - before).toBe(1);
  });

  it("restores the turn spinner after a batch and hides it for pause and turn end", async () => {
    let label: string | null = "thinking…";
    let afterBatch: string | null = null;
    let duringPause: string | null = "not paused";
    const session = makeMockSession({
      config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 2, hard_max_steps: 300 } }),
    });
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const count = req.messages.filter((m) => m.role === "tool_result").length;
      if (count === 1) afterBatch = label;
      return makeLoopStream(req, 3);
    });
    const sink: TurnUiSink = {
      onSpinnerStart: (text) => { label = text; },
      onSpinnerStop: () => { label = null; },
      onStepPause: () => {
        label = null; // The TUI stops its spinner before opening the overlay.
        duringPause = label;
        return false;
      },
    };
    try {
      await runTurn(session, "spinner lifecycle", undefined, { sink });
    } finally {
      label = null; // The TUI stops its spinner at turn end.
    }
    expect(afterBatch).toBe("thinking…");
    expect(duringPause).toBeNull();
    expect(label).toBeNull();
  });

  function pauseForSpinner() {
    return makeMockSession({
      config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }),
    });
  }

  function toolThenWrap(
    events: string[],
    wrap: () => AsyncGenerator<unknown>,
  ): void {
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = [...req.messages].reverse().find((m) => m.role === "user");
      const text = typeof last?.content === "string" ? last.content : "";
      if (text.includes("Do not call tools")) {
        events.push("request");
        return wrap();
      }
      return (async function* () {
        yield {
          type: "toolcall_end",
          toolCall: { id: "call-0", name: "shell", arguments: { command: "echo call-0" } },
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-0", name: "shell", args: { command: "echo call-0" } }],
          },
        };
      })();
    });
  }

  function spinnerSink(events: string[]): TurnUiSink {
    return {
      onStepPause: () => false,
      onSpinnerStart: (text: string) => {
        events.push(`start:${text}`);
      },
      onSpinnerStop: () => {
        events.push("stop");
      },
    };
  }

  function expectWrapSpinner(events: string[], stopBefore?: string): void {
    const starts = events.filter((event) => event.startsWith("start:"));
    expect(starts).toEqual(["start:wrapping up…"]);
    expect(starts[0]).not.toMatch(/\d/);
    const startAt = events.indexOf("start:wrapping up…");
    const requestAt = events.indexOf("request");
    const stops = events.filter((event) => event === "stop");
    expect(stops).toHaveLength(1);
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeLessThan(requestAt);
    if (stopBefore) {
      expect(events.indexOf("stop")).toBeLessThan(events.indexOf(stopBefore));
    } else {
      expect(events.indexOf("stop")).toBeGreaterThan(requestAt);
    }
  }

  it("shows wrapping up until the first summary text", async () => {
    const events: string[] = [];
    toolThenWrap(events, async function* () {
      yield { type: "text_delta", delta: "summary" };
      events.push("after-delta");
      yield { type: "done", reason: "stop", message: { role: "assistant", content: "summary" } };
    });
    await runTurn(pauseForSpinner(), "spin success", undefined, { sink: spinnerSink(events) });
    expectWrapSpinner(events, "after-delta");
  });

  it("stops the wrapping up spinner once when the summary fails", async () => {
    const events: string[] = [];
    toolThenWrap(events, async function* () {
      yield { type: "error", error: new Error("wrap-up provider 500"), retryable: false };
    });
    await runTurn(pauseForSpinner(), "spin fail", undefined, { sink: spinnerSink(events) });
    expectWrapSpinner(events);
  });

  it("stops the wrapping up spinner once when the summary is aborted", async () => {
    const abort = new AbortController();
    const events: string[] = [];
    toolThenWrap(events, async function* () {
      abort.abort();
      yield { type: "done", reason: "aborted", message: { role: "assistant", content: "" } };
    });
    let thrown: unknown;
    try {
      await runTurn(pauseForSpinner(), "spin abort", undefined, {
        sink: spinnerSink(events),
        signal: abort.signal,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TurnAbortedError);
    expectWrapSpinner(events);
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
    const agent = String(
      session.eventLog.readAll().filter((e: { kind?: string }) => e.kind === "agent_message").at(-1)?.payload?.text ?? "",
    );
    expect(agent).toContain((thrown as TurnAbortedError).partialResponse);
    expect(agent).not.toContain("Do not call tools");
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

  it("separates wrap-up text, drops the instruction, and reports a failed summary", async () => {
    llmWarns.length = 0;
    const userInput = "step then fail wrap";
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = req.messages.at(-1);
      const lastText = typeof last?.content === "string" ? last.content : "";
      if (lastText.includes("Do not call tools")) {
        return (async function* () {
          yield { type: "error", error: new Error("wrap-up provider 500"), retryable: false };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "did the work" };
        yield {
          type: "toolcall_end",
          toolCall: { id: "call-0", name: "shell", arguments: { command: "echo call-0" } },
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: "did the work",
            toolCalls: [{ id: "call-0", name: "shell", args: { command: "echo call-0" } }],
          },
        };
      })();
    });
    const session = makeMockSession({
      config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }),
    });
    const order: string[] = [];
    const errors: string[] = [];
    const histories = await historyArraysFor(userInput, () =>
      runTurn(session, userInput, undefined, {
        sink: {
          onStepPause: () => false,
          onTextDelta: (delta) => order.push(delta),
          onSystemLines: (lines) => order.push(...lines),
          onError: (entry) => errors.push(entry.message),
        },
      }),
    );
    expect(order.indexOf("Stopped at the step pause.")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("Stopped at the step pause.")).toBeLessThan(order.length);
    expect(errors).toContain("wrap-up provider 500");
    const stored = session.eventLog.readAll().filter((e: { kind?: string }) => e.kind === "agent_message");
    const agent = String(stored.at(-1)?.payload?.text ?? "");
    expect(agent).toContain("did the work");
    expect(agent).not.toContain("Do not call tools");
    expect(histories.some((h) => JSON.stringify(h).includes("Do not call tools"))).toBe(false);
  });

  it("inserts a blank line between step text and a stored wrap-up summary", async () => {
    const userInput = "step then summary";
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = req.messages.at(-1);
      const lastText = typeof last?.content === "string" ? last.content : "";
      if (lastText.includes("Do not call tools")) {
        return (async function* () {
          yield { type: "text_delta", delta: "[summary] wrapped up" };
          yield {
            type: "done",
            reason: "stop",
            message: { role: "assistant", content: "[summary] wrapped up" },
          };
        })();
      }
      return (async function* () {
        yield { type: "text_delta", delta: "did the work" };
        yield {
          type: "toolcall_end",
          toolCall: { id: "call-0", name: "shell", arguments: { command: "echo call-0" } },
        };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: "did the work",
            toolCalls: [{ id: "call-0", name: "shell", args: { command: "echo call-0" } }],
          },
        };
      })();
    });
    const session = makeMockSession({
      config: makeConfig({ turn: { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 } }),
    });
    const deltas: string[] = [];
    await runTurn(session, userInput, undefined, {
      sink: {
        onStepPause: () => false,
        onTextDelta: (delta) => deltas.push(delta),
      },
    });
    expect(deltas.join("")).toContain("did the work\n\n[summary] wrapped up");
    const agent = String(
      session.eventLog.readAll().filter((e: { kind?: string }) => e.kind === "agent_message").at(-1)?.payload?.text ?? "",
    );
    expect(agent).toContain("did the work\n\n[summary] wrapped up");
    expect(agent).not.toContain("Do not call tools");
  });

  it("does not store a thinking-only wrap-up and drops the instruction", async () => {
    const userInput = "thinking wrap";
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      const last = req.messages.at(-1);
      const lastText = typeof last?.content === "string" ? last.content : "";
      if (lastText.includes("Do not call tools")) {
        return (async function* () {
          yield { type: "thinking_delta", delta: "secret-thought" };
          yield {
            type: "done",
            reason: "stop",
            message: { role: "assistant", content: "   ", thinking: "secret-thought" },
          };
        })();
      }
      return makeLoopStream(req, 1, { withToolCalls: true });
    });
    const session = makeMockSession({
      headless: true,
      config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }),
    });
    const histories = await historyArraysFor(userInput, () =>
      runTurn(session, userInput, undefined, { sink: {} }),
    );
    const agent = String(
      session.eventLog.readAll().filter((e: { kind?: string }) => e.kind === "agent_message").at(-1)?.payload?.text ?? "",
    );
    expect(agent).not.toContain("secret-thought");
    expect(agent).not.toContain("Do not call tools");
    expect(histories.some((h) => JSON.stringify(h).includes("Do not call tools"))).toBe(false);
    expect(
      histories.some((h) =>
        h.some(
          (m) =>
            m?.role === "assistant" &&
            !m.toolCalls &&
            !(typeof m.content === "string" ? m.content.trim() : ""),
        ),
      ),
    ).toBe(false);
  });

  it("does not store an empty assistant message after stripping wrap-up calls", async () => {
    mockStream.mockImplementation((req: FakeStreamRequest) => {
      if (String(req.messages.at(-1)?.content ?? "").includes("Do not call tools")) {
        return (async function* () {
          yield { type: "done", reason: "toolUse", message: { role: "assistant", content: "", toolCalls: [{ id: "extra", name: "shell", args: {} }] } };
        })();
      }
      return makeLoopStream(req, 5, { withToolCalls: true });
    });
    const session = makeMockSession({ headless: true, config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }) });
    const pushed: unknown[] = [];
    const original = Array.prototype.push;
    Array.prototype.push = function (...items: any[]) {
      for (const item of items) {
        if (item?.role === "assistant" && item.content === "" && !item.toolCalls) original.call(pushed, item);
      }
      return original.apply(this, items);
    };
    try {
      await runTurn(session, "empty stripped message", undefined, { sink: {} });
    } finally {
      Array.prototype.push = original;
    }
    expect(pushed).toEqual([]);
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

describe("per-turn step budget — default sink", () => {
  it("uses max_steps when the terminal is not interactive", async () => {
    expect(Boolean(process.stdin.isTTY && process.stdout.isTTY)).toBe(false);
    mockStream.mockReset();
    installLoopStream(5);
    const session = makeMockSession({ config: makeConfig({ turn: { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 } }) });
    await runTurn(session, "default sink");
    expect(streamRequestCalls()).toHaveLength(2);
    expect(shellExecuteCount()).toBe(1);
  });
});

describe("per-turn step budget — headless hard cap", () => {
  beforeEach(() => {
    (mockStream as ReturnType<typeof mock>).mockReset();
  });

  it("uses the guarded wrap-up path when the circuit budget expires", async () => {
    installLoopStream(5, { withToolCalls: true, wrapUp: "error" });
    const config = makeConfig({ turn: { max_steps: 25, pause_after_steps: 50, hard_max_steps: 300 } });
    config.circuit = { loop_threshold: 3, max_tokens: 0, max_wall_ms: 1 };
    const session = makeMockSession({ headless: true, config });
    const errors: string[] = [];
    await runTurn(session, "circuit", undefined, { sink: { onFallback: (text) => errors.push(text) } });
    expect(streamRequestCalls().at(-1)?.tools).toEqual([]);
    expect(errors.join(" ")).toContain("wrap-up provider 500");
    expect(shellExecuteCount()).toBe(0);
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
    const toolResults = lastReq.messages.filter((m) => String(m.content ?? "").startsWith("Tool result ("));
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
    expect(last.messages.filter((m) => String(m.content ?? "").startsWith("Tool result ("))).toHaveLength(3);
    expect(last.messages.some((m) => String(m.content ?? "").includes(NOT_EXECUTED))).toBe(false);
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

  it("disables the pause when hard_max_steps is below pause_after_steps and keeps the ceiling", () => {
    getConfigWarnings();
    writeTurnConfig("[turn]\npause_after_steps = 40\nhard_max_steps = 10\n");
    const config = loadConfig();
    const t = config.turn as TurnConfig;
    expect(t.pause_after_steps).toBe(40);
    expect(t.hard_max_steps).toBe(10);
    expect(getConfigWarnings()).toContain(
      "turn.hard_max_steps (10) is not above turn.pause_after_steps (40); the pause is disabled and the turn stops at the ceiling (10) with a wrap-up.",
    );
  });

  it("disables the pause when hard_max_steps equals pause_after_steps", () => {
    getConfigWarnings();
    writeTurnConfig("[turn]\npause_after_steps = 40\nhard_max_steps = 40\n");
    const config = loadConfig();
    const t = config.turn as TurnConfig;
    expect(t.pause_after_steps).toBe(40);
    expect(t.hard_max_steps).toBe(40);
    expect(getConfigWarnings()).toContain(
      "turn.hard_max_steps (40) is not above turn.pause_after_steps (40); the pause is disabled and the turn stops at the ceiling (40) with a wrap-up.",
    );
  });

  it("keeps both values when hard_max_steps is above pause_after_steps", () => {
    getConfigWarnings();
    writeTurnConfig("[turn]\npause_after_steps = 7\nhard_max_steps = 99\n");
    const config = loadConfig();
    const t = config.turn as TurnConfig;
    expect(t.pause_after_steps).toBe(7);
    expect(t.hard_max_steps).toBe(99);
    expect(getConfigWarnings().some((w) => w.includes("pause is disabled"))).toBe(false);
  });
});
