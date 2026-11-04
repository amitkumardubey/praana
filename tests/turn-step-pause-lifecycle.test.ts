/**
 * Randomized pause / abort / wrap-up lifecycle.
 *
 * Seeds are integers. Seed N is fed to mulberry32 (the same numeric generator
 * every run) and `buildSchedule` reads that stream in a fixed order, then
 * applies the coercions documented on `buildSchedule`. The same seed always
 * produces the same schedule. Default is 300 seeds. Set `PRAANA_PAUSE_SEEDS`
 * to run more. Set `PRAANA_PAUSE_SEED` to replay one seed.
 *
 * A hook that never settles and is never aborted is out of scope (nothing can
 * unblock the turn). `buildSchedule` rewrites that pair so an abort always
 * fires. The check is that the turn ends on that abort within one tick of the
 * signal, including when the hook ignores the signal.
 *
 * Named checks:
 * I1 pause resolves once and leaves no overlay, readline, or stdin listener behind
 * I2 history is valid for the next request (tool pairs, no leftover instruction,
 *    no empty assistant, instruction absent from the next turn's transcript)
 * I3 one limit notice, before wrap-up text; a failed wrap-up calls onError
 * I4 a sink with no pause hook never pauses; a throw or reject stops
 * I5 the pause signal aborts when the turn ends, and a hook that ignores it
 *    cannot keep the turn blocked after an abort
 * I6 a Ctrl+C during the pause aborts the turn. Removal checks: no wrap-up
 *    request, the pause promise settles exactly once, the confirm prompt is
 *    gone, and focus is restored when no other overlay is open.
 */
import { describe, expect, it, afterAll, mock } from "bun:test";
import { z } from "zod";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
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

const mockStream = mock();
let abortDuringTool: (() => void) | null = null;

const ceReal = { ...contextEngineActual };
const ccReal = { ...compileClassicActual };
const llmReal = { ...llmActual };
const toolsReal = { ...toolsActual };
const autoCompactReal = { ...autoCompactActual };
const uiReal = { ...uiActual };
const nativeLlmReal = { ...nativeLlmActual };

mock.module("../src/llm/index.js", () => ({
  ...nativeLlmActual,
  streamLlmResponse: mockStream,
}));
mock.module("../src/compiler.js", () => ({}));
mock.module("../src/context-engine/index.js", () => ({
  ...contextEngineActual,
  compileEngineWithMetrics: mock(() => ({
    prompt: "engine compiled prompt",
    metrics: { totalTokens: 10, systemFrameTokens: 1, agentsContextTokens: 0, skillsCatalogTokens: 0, checkpointTokens: 0, crossSessionTokens: 0, activeStateTokens: 0, peripheralStubsTokens: 0, recentTurnsTokens: 0, currentInputTokens: 1, activeObjectCount: 0, peripheralObjectCount: 0, recentTurnsTruncated: false, memoryTruncated: false, agentsContextTruncated: false, skillsTruncated: false },
    scoreRecords: [],
    pressureRatio: 0,
    pressureMode: "normal" as const,
    weightedTokens: 0,
    rawPressureRatio: 0,
    excludedScoredUnits: 0,
  })),
}));
mock.module("../src/auto-compact.js", () => ({
  maybeAutoCompactClassic: mock(async () => ({ compacted: false, eventsCompacted: 0, factsStored: 0, pressureRatio: 0 })),
  formatCompactionBanner: mock(() => null),
}));
mock.module("../src/compile-classic.js", () => ({
  compileClassicWithMetrics: mock(() => ({
    prompt: "classic compiled prompt",
    metrics: { totalTokens: 10, systemFrameTokens: 1, agentsContextTokens: 0, skillsCatalogTokens: 0, checkpointTokens: 0, crossSessionTokens: 0, activeStateTokens: 0, peripheralStubsTokens: 0, recentTurnsTokens: 0, currentInputTokens: 1, activeObjectCount: 0, peripheralObjectCount: 0, recentTurnsTruncated: false, memoryTruncated: false, agentsContextTruncated: false, skillsTruncated: false },
  })),
}));
mock.module("../src/tools/index.js", () => ({
  createAllTools: mock(() => ({
    shell: {
      description: "Execute a shell command",
      parameters: z.object({ command: z.string() }),
      execute: () => {
        abortDuringTool?.();
        return Promise.resolve({ ok: true, stdout: "hello" });
      },
    },
  })),
  describeTools: mock(() => ["shell(command) — Execute a shell command"]),
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
import { TurnAbortedError } from "../src/turn-control.js";
import { createBuiltinHookRegistry } from "../src/hooks/index.js";
import { LoopGate } from "../src/circuit/loop-gate.js";
import { StateGraph } from "../src/state-graph.js";
import { createDefaultTurnSink, type TurnUiSink } from "../src/ui-events.js";
import { createOverlayUi } from "../src/ui/tui/overlays/state.js";
import { classifyStepPauseKey } from "../src/ui/tui/overlays/confirm.js";
import type { PraanaConfig } from "../src/types.js";

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

const INSTRUCTION = "Do not call tools";
const STOP_LINE = "Stopped at the step pause.";
const LIMIT_PREFIX = "Reached the step limit";

type Answer = "continue" | "stop" | "throw" | "reject" | "never";
type AbortAt = "none" | "before-pause" | "during-pause" | "during-wrap" | "during-tool";
type Wrap = "success" | "error" | "empty" | "thinking" | "interrupted";
type Limit = "pause" | "ceiling" | "cap";
type Io = "memory" | "eof" | "readline-abort";

interface Schedule {
  seed: number;
  turns: 1 | 2 | 3;
  limit: Limit;
  hasHook: boolean;
  answer: Answer;
  answerDelay: "immediate" | "delayed";
  abortAt: AbortAt;
  io: Io;
  wrap: Wrap;
  otherOverlay: boolean;
  /** Open a palette before the confirm so the pause must not replace it. */
  overlayBeforeConfirm: boolean;
  /** Ctrl+C at the pause. The key policy decides whether that aborts. */
  ctrlC: boolean;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

/**
 * Coercions (applied in this order, so the stored schedule is what ran):
 * - `cap` has no hook. `ceiling` stops on step 1 without asking.
 * - `never` with no abort is rewritten to abort during the pause.
 * - stdin EOF / readline-abort only run on a real pause, and they own the answer.
 * - an abort that names a pause which will not happen is moved to a point that will.
 * - wrap-up outcome is ignored when the turn never reaches a wrap-up.
 * - `interrupted` wrap-up is an abort during the wrap-up.
 */
function buildSchedule(seed: number): Schedule {
  const rng = mulberry32(seed);
  const turns = (1 + Math.floor(rng() * 3)) as 1 | 2 | 3;
  let limit = pick(rng, ["pause", "ceiling", "cap"] as const);
  let answer = pick(rng, ["continue", "stop", "throw", "reject", "never"] as const);
  const answerDelay = pick(rng, ["immediate", "delayed"] as const);
  let abortAt = pick(rng, ["none", "before-pause", "during-pause", "during-wrap", "during-tool"] as const);
  let io = pick(rng, ["memory", "eof", "readline-abort"] as const);
  let wrap = pick(rng, ["success", "error", "empty", "thinking", "interrupted"] as const);
  let otherOverlay = rng() < 0.5;
  // The ceiling still needs a hook so the interactive ceiling runs; it just never asks.
  // Only the headless-style cap omits the hook.
  const hasHook = limit !== "cap";

  // A hook that never returns only ends if the pause itself is aborted.
  if (limit === "pause" && answer === "never" && abortAt !== "before-pause") abortAt = "during-pause";
  if ((answer === "throw" || answer === "reject") && abortAt === "during-pause") abortAt = "none";
  // Stop / throw / reject never reach the tool batch, so a tool abort becomes a wrap-up abort.
  if (limit === "pause" && answer !== "continue" && abortAt === "during-tool") abortAt = "during-wrap";
  if (limit !== "pause") io = "memory";
  if (io !== "memory") {
    otherOverlay = false;
    answer = "stop";
    abortAt = io === "readline-abort" ? "during-pause" : "none";
  }
  if (!hasHook && abortAt === "during-pause") abortAt = "during-tool";
  if (limit === "ceiling" && (abortAt === "during-pause" || abortAt === "during-tool")) abortAt = "during-wrap";
  // Continuing never starts a wrap-up, so an abort aimed at the wrap-up runs during the tool instead.
  if (limit === "pause" && answer === "continue" && abortAt === "during-wrap") abortAt = "during-tool";
  if (wrap === "interrupted" && abortAt === "none") {
    abortAt = limit === "pause" && answer === "continue" ? "during-tool" : "during-wrap";
  }

  const reachesWrap =
    abortAt !== "before-pause" &&
    abortAt !== "during-pause" &&
    abortAt !== "during-tool" &&
    !(limit === "pause" && answer === "continue");
  if (!reachesWrap) wrap = "success";
  if (abortAt === "during-wrap") wrap = "interrupted";
  if (limit !== "pause") otherOverlay = false;
  // Drawn last so earlier fields stay stable for a given seed.
  let overlayBeforeConfirm = rng() < 0.5;
  if (!otherOverlay) overlayBeforeConfirm = false;
  let ctrlC = rng() < 0.4;
  if (limit !== "pause" || io !== "memory" || !hasHook) ctrlC = false;
  if (answer === "throw" || answer === "reject" || answer === "never") ctrlC = false;
  if (overlayBeforeConfirm) ctrlC = false;
  if (ctrlC) {
    abortAt = "none";
    wrap = "success";
  }

  return {
    seed,
    turns,
    limit,
    hasHook,
    answer,
    answerDelay,
    abortAt,
    io,
    wrap,
    otherOverlay,
    overlayBeforeConfirm,
    ctrlC,
  };
}

function seedList(): number[] {
  const only = process.env.PRAANA_PAUSE_SEED;
  if (only && Number.isInteger(Number(only)) && Number(only) > 0) return [Number(only)];
  const raw = Number(process.env.PRAANA_PAUSE_SEEDS ?? "300");
  const count = Number.isInteger(raw) && raw > 0 ? raw : 300;
  return Array.from({ length: count }, (_, i) => i + 1);
}

function reachesWrap(s: Schedule): boolean {
  if (s.ctrlC) return false;
  return (
    s.abortAt !== "before-pause" &&
    s.abortAt !== "during-pause" &&
    s.abortAt !== "during-tool" &&
    !(s.limit === "pause" && s.answer === "continue")
  );
}

function expectsAbort(s: Schedule): boolean {
  return s.abortAt !== "none" || s.ctrlC;
}

class FakeStdin extends PassThrough {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
}

function makeSession(logDir: string, limit: Limit) {
  const turn =
    limit === "cap"
      ? { max_steps: 1, pause_after_steps: 50, hard_max_steps: 300 }
      : limit === "ceiling"
        ? { max_steps: 25, pause_after_steps: 1, hard_max_steps: 1 }
        : { max_steps: 25, pause_after_steps: 1, hard_max_steps: 300 };
  const config = {
    llm: { provider: "lifecycle-test", model: "test-model" },
    memory: { enabled: false, summarizer: "openrouter", db_path: ":memory:", embedder: "auto", ollama_url: "http://localhost:11434", ollama_model: "nomic-embed-text" },
    compiler: { token_budget: 100_000, recent_turns: 10, recent_turns_token_budget: 30_000 },
    tiers: { idle_soft_after_turns: 3, idle_hard_after_turns: 6 },
    session: { log_dir: logDir },
    consolidation: { enabled: false, promotion_threshold: 3, run_delay_seconds: 30 },
    shell: { enabled: false, allowed_paths: [] },
    edit: { confirm: false },
    skills: { enabled: false, max_token_budget_ratio: 0.2, max_loaded_skills: 3, stale_threshold_turns: 10, max_depth: 6 },
    ui: { mode: "readline", screen: "preserve" },
    context_engine: { enabled: false, measurement_mode: false, artifact_inline_threshold: 400, artifact_ttl_turns: 50, distiller: { default_intensity: "full" }, llm_digest: false, activity_log_max_entries: 15, checkpoint_enabled: true, scoring: { w_pin: 1, w_recency: 0.5, w_relevance: 0.3 }, pressure: { compact_at: 0.7, emergency_at: 0.85 } },
    project_detection: { enabled: false },
    turn,
  } as PraanaConfig;
  const events: Array<Record<string, any>> = [];
  const eventLog = {
    append: (ev: Record<string, unknown>) => {
      events.push({ event_id: `e${events.length}`, ...ev });
    },
    readAll: () => events.slice(),
    readAllUncompressed: () => events.slice(),
    readAllUncompressedAfterResetBoundary: () => events.slice(),
    readLast: (n: number) => events.slice(-n),
    readLastUncompressed: (n: number) => events.slice(-n),
    readLastUncompressedAfterResetBoundary: (n: number) => events.slice(-n),
    markEventsAsCompressed: () => {},
    search: () => [],
    clear: () => { events.length = 0; },
  };
  const loopGate = new LoopGate({ threshold: 3 });
  const session: any = {
    id: "pause-lifecycle",
    cwd: "/home/test/project",
    headless: false,
    config,
    eventLog,
    stateGraph: new StateGraph(),
    hooks: createBuiltinHookRegistry("/home/test/project", {
      validate: { pathExists: () => true, commandOnPath: () => true },
    }),
    confirmRisk: async () => ({ allowed: true }),
    loopGate,
    observeCircuitPre: (tool: string, args: Record<string, unknown>) => loopGate.observePre(tool, args),
    observeCircuitPost: (tool: string, args: Record<string, unknown>, isError: boolean) => loopGate.observePost(tool, args, isError),
    circuitNotes: () => loopGate.notes(),
    getStartedAt: () => Date.now() - 1000,
    memoryStore: null,
    memoryEnabled: false,
    incognito: false,
    contextEngine: null,
    scorecard: createNullScorecard(),
    digest: null,
    agentsContext: null,
    debug: false,
    promptDir: join(logDir, "prompts"),
    _turnCount: 0,
    incrementTurn() { this._turnCount++; },
    persistStateGraphCheckpoint() {},
    getTurnCount() { return this._turnCount; },
    getLastResetBoundaryTurn() { return -1; },
    getVisibleSessionCheckpoint() { return undefined; },
    getMemoryStats() { return { total: 0, active: 0, soft: 0, hard: 0, byKind: {} }; },
    setLastCompileMetrics() {},
    getLastCompileMetrics() { return null; },
    setLastCompileScoreRecords() {},
    getLastCompileScoreRecords() { return []; },
    getLastPressureMode() { return "normal"; },
    getLastPressureRatio() { return 0; },
    getLastWeightedTokens() { return 0; },
    getLastRawPressureRatio() { return 0; },
    setDisplayContextSnapshot() {},
    getDisplayContextSnapshot() { return null; },
    setLastKnownTaskType() {},
    setLastUserInput() {},
    getLastUserInput() { return ""; },
    isIncognito() { return false; },
    isContextEngineEnabled() { return false; },
    planMode: false,
    isPlanMode() { return false; },
    exitPlanMode() {},
    skills: [],
    recordInputTokens() {},
    recordOutputTokens() {},
    ensureModelContextWindow: async () => 128_000,
    getEffectiveLlmConfig() { return this.config.llm; },
    getEffectiveProvider() { return this.config.llm.provider; },
    getActiveModelId() { return this.config.llm.model; },
    getModelOverride() { return null; },
    getProviderOverride() { return null; },
    getEffectiveReasoningEffort() { return "medium"; },
    recordReasoningEffortUsed() {},
    getLogger() { return { child: () => ({ warn() {}, error() {}, info() {} }) }; },
    isCompactionArmed: () => false,
    setCompactionArmed() {},
    clearResumed() {},
  };
  return session;
}

function installStream(schedule: Schedule, abort: AbortController, turn: number, trace: TurnTrace): void {
  const callId = `call-${schedule.seed}-${turn}`;
  mockStream.mockImplementation((req: { messages?: Array<{ role?: string; content?: unknown }> }) => {
    const messages = req.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const lastText = typeof lastUser?.content === "string" ? lastUser.content : "";
    const isWrap = lastText.includes(INSTRUCTION);
    if (isWrap) trace.wrapRequests += 1;
    const toolResults = messages.filter((m) => m.role === "tool_result").length;
    if (isWrap) return wrapStream(schedule, abort);
    if (schedule.abortAt === "before-pause" && toolResults === 0) {
      return (async function* () {
        yield { type: "text_delta", delta: "partial before" };
        abort.abort();
      })();
    }
    if (toolResults === 0) {
      return (async function* () {
        yield { type: "text_delta", delta: "did the work" };
        yield { type: "toolcall_end", toolCall: { id: callId, name: "shell", arguments: { command: `echo ${callId}` } } };
        yield {
          type: "done",
          reason: "toolUse",
          message: {
            role: "assistant",
            content: "did the work",
            toolCalls: [{ id: callId, name: "shell", args: { command: `echo ${callId}` } }],
          },
        };
      })();
    }
    return (async function* () {
      yield { type: "text_delta", delta: "final answer" };
      yield { type: "done", reason: "stop", message: { role: "assistant", content: "final answer" } };
    })();
  });
}

function wrapStream(schedule: Schedule, abort: AbortController) {
  if (schedule.wrap === "error") {
    return (async function* () {
      yield { type: "error", error: new Error("wrap-up provider 500"), retryable: false };
    })();
  }
  if (schedule.wrap === "interrupted") {
    return (async function* () {
      yield { type: "text_delta", delta: "partial wrap" };
      abort.abort();
    })();
  }
  if (schedule.wrap === "empty") {
    return (async function* () {
      yield { type: "done", reason: "stop", message: { role: "assistant", content: "   " } };
    })();
  }
  if (schedule.wrap === "thinking") {
    return (async function* () {
      yield { type: "thinking_delta", delta: "secret-thought" };
      yield { type: "done", reason: "stop", message: { role: "assistant", content: "", thinking: "secret-thought" } };
    })();
  }
  return (async function* () {
    yield { type: "text_delta", delta: "[summary] wrapped up" };
    yield { type: "done", reason: "stop", message: { role: "assistant", content: "[summary] wrapped up" } };
  })();
}

interface TurnTrace {
  order: string[];
  errors: string[];
  signals: Array<AbortSignal | undefined>;
  pauseCalls: number[];
  pending: boolean;
  focused: boolean;
  spinner: "running" | "stopped";
  overlayStolen: boolean;
  overlayAfter: string;
  stdinListeners: number | null;
  stdinPaused: boolean | null;
  stdinBaseline: number | null;
  wrapRequests: number;
  pauseSettles: number;
  confirmLeft: boolean;
}

function historyArrays(userInput: string, run: () => Promise<void>): Promise<any[][]> {
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
  return run().finally(() => {
    Array.prototype.push = original;
  }).then(() => [...new Set(found)]);
}

function checkI1(trace: TurnTrace, schedule: Schedule): void {
  if (schedule.answer !== "never") expect(trace.pending).toBe(false);
  if (
    schedule.io === "memory" &&
    (schedule.answer === "continue" || schedule.answer === "stop") &&
    schedule.hasHook &&
    schedule.limit === "pause" &&
    !expectsAbort(schedule)
  ) {
    expect(trace.focused).toBe(true);
    if (schedule.answer === "continue") expect(trace.spinner).toBe("running");
  }
  if (
    schedule.otherOverlay &&
    !schedule.overlayBeforeConfirm &&
    schedule.abortAt !== "during-pause" &&
    schedule.answer !== "throw" &&
    schedule.answer !== "reject"
  ) {
    expect(trace.overlayStolen).toBe(false);
    expect(trace.overlayAfter).toBe("model");
  }
  if (
    schedule.otherOverlay &&
    schedule.overlayBeforeConfirm &&
    schedule.abortAt !== "during-pause" &&
    schedule.answer !== "throw" &&
    schedule.answer !== "reject"
  ) {
    expect(trace.overlayStolen).toBe(false);
    expect(trace.overlayAfter).toBe("none");
  }
  if (schedule.otherOverlay && schedule.abortAt === "during-pause") {
    expect(trace.overlayAfter).not.toBe("confirm");
  }
  if (schedule.io !== "memory") {
    expect(trace.stdinListeners).toBe(trace.stdinBaseline);
    expect(trace.stdinPaused).toBe(true);
  }
}

function checkI2(histories: any[][], events: Array<Record<string, any>>, fromEvent: number, schedule: Schedule): void {
  // An interrupt before the first response completes can leave the initial array untouched.
  if (schedule.abortAt !== "before-pause") expect(histories.length).toBeGreaterThan(0);
  for (const history of histories) {
    expect(JSON.stringify(history)).not.toContain(INSTRUCTION);
    expect(JSON.stringify(history)).not.toContain("secret-thought");
    const resultIds = new Set(
      history.filter((m) => m?.role === "toolResult" || m?.role === "tool_result").map((m) => m.toolCallId),
    );
    const callIds = history.flatMap((m) =>
      m?.role === "assistant" && Array.isArray(m.toolCalls) ? m.toolCalls.map((c: { id?: string }) => c.id) : [],
    );
    expect(callIds.filter((id: string) => !resultIds.has(id))).toEqual([]);
    const empty = history.filter((m) => {
      if (m?.role !== "assistant" || (Array.isArray(m.toolCalls) && m.toolCalls.length > 0)) return false;
      const text = typeof m.content === "string" ? m.content : "";
      return text.trim().length === 0;
    });
    expect(empty).toEqual([]);
  }
  const fresh = events.slice(fromEvent);
  for (const event of fresh) {
    if (event.kind !== "user_message" && event.kind !== "agent_message") continue;
    const text = String(event.payload?.text ?? "");
    expect(text).not.toContain(INSTRUCTION);
    expect(text).not.toContain("secret-thought");
  }
}

function checkI3(trace: TurnTrace, schedule: Schedule): void {
  const notices = trace.order.filter((line) => line === STOP_LINE || line.startsWith(LIMIT_PREFIX));
  const wantNotice = reachesWrap(schedule) || (schedule.hasHook && schedule.answer !== "continue" && !expectsAbort(schedule));
  if (!wantNotice) {
    expect(notices).toEqual([]);
    return;
  }
  expect(notices).toHaveLength(1);
  const stopForPause = schedule.limit === "pause" && schedule.answer !== "continue";
  if (stopForPause) expect(notices[0]).toBe(STOP_LINE);
  else expect(notices[0]?.startsWith(LIMIT_PREFIX)).toBe(true);
  const noticeAt = trace.order.indexOf(notices[0]!);
  const wrapAt = trace.order.findIndex((line) => line.includes("[summary] wrapped up") || line.includes("partial wrap"));
  if (wrapAt >= 0) expect(noticeAt).toBeLessThan(wrapAt);
  if (schedule.wrap === "error") expect(trace.errors.some((e) => e.includes("wrap-up provider 500"))).toBe(true);
  if (schedule.wrap === "success") {
    const joined = trace.order.join("");
    const work = joined.indexOf("did the work");
    const summary = joined.indexOf("\n\n[summary] wrapped up");
    expect(work).toBeGreaterThanOrEqual(0);
    expect(summary).toBeGreaterThan(work);
  }
}

function checkI4(trace: TurnTrace, schedule: Schedule, threw: unknown): void {
  if (!schedule.hasHook || schedule.limit === "ceiling") expect(trace.pauseCalls).toEqual([]);
  if (trace.pauseCalls.length > 0 && (schedule.answer === "throw" || schedule.answer === "reject")) {
    expect(threw).toBeUndefined();
    expect(trace.order).toContain(STOP_LINE);
  }
}

function checkI5(trace: TurnTrace, schedule: Schedule, elapsedMs: number): void {
  if (!schedule.hasHook || schedule.limit !== "pause") return;
  if (schedule.abortAt === "before-pause") return;
  expect(trace.signals.length).toBeGreaterThan(0);
  for (const signal of trace.signals) {
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
  }
  if (schedule.answer === "never" || schedule.io === "readline-abort") expect(elapsedMs).toBeLessThan(500);
}

async function runTurnBounded(
  session: any,
  userInput: string,
  sink: TurnUiSink,
  signal: AbortSignal,
): Promise<{ value?: string; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timeout: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timeout: true }), 250);
  });
  const turn = runTurn(session, userInput, undefined, { sink, signal }).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const result = await Promise.race([turn, timeout]);
  clearTimeout(timer);
  if ("timeout" in result) return { error: new Error("turn did not end within 250ms") };
  return result;
}

async function runSeed(schedule: Schedule, logDir: string): Promise<void> {
  const session = makeSession(logDir, schedule.limit);
  for (let n = 0; n < schedule.turns; n++) {
    const userInput = `seed-${schedule.seed}-turn-${n}`;
    const abort = new AbortController();
    const trace: TurnTrace = {
      order: [],
      errors: [],
      signals: [],
      pauseCalls: [],
      pending: false,
      focused: false,
      spinner: "stopped",
      overlayStolen: false,
      overlayAfter: "none",
      stdinListeners: null,
      stdinPaused: null,
      stdinBaseline: null,
      wrapRequests: 0,
      pauseSettles: 0,
      confirmLeft: false,
    };
    installStream(schedule, abort, n, trace);
    abortDuringTool = schedule.abortAt === "during-tool" ? () => abort.abort() : null;
    const fromEvent = session.eventLog.readAll().length;
    const started = Date.now();
    const overlay = schedule.otherOverlay || schedule.ctrlC ? createOverlayUi() : null;

    const answerValue = schedule.answer === "continue";
    const memoryPause = (steps: number, signal?: AbortSignal): boolean | Promise<boolean> => {
      trace.pauseCalls.push(steps);
      trace.signals.push(signal);
      trace.spinner = "stopped";
      const settle = (value: boolean) => {
        trace.pending = false;
        trace.focused = true;
        trace.spinner = value ? "running" : "stopped";
        return value;
      };
      if (schedule.answer === "throw") throw new Error("pause hook failed");
      if (schedule.answer === "reject") return Promise.reject(new Error("pause hook rejected"));
      trace.pending = true;
      if ((schedule.otherOverlay || schedule.ctrlC) && overlay && signal) {
        if (schedule.overlayBeforeConfirm) overlay.showPalette();
        const pending = overlay.showConfirm(`Used ${steps}?`, signal);
        let settles = 0;
        pending.then(() => {
          settles += 1;
        });
        const track = (value: boolean) => {
          trace.pauseSettles = settles;
          trace.overlayAfter = overlay.kind();
          trace.confirmLeft = overlay.kind() === "confirm" || overlay.confirmPrompt() !== null;
          trace.focused = overlay.kind() === "none";
          trace.pending = false;
          trace.spinner = value ? "running" : "stopped";
          return value;
        };
        const applyCtrlC = () => {
          const decision = classifyStepPauseKey("c", true, schedule.answerDelay === "delayed");
          if (decision === "passthrough") abort.abort();
          else if (decision === "stop") overlay.resolveConfirm(false);
          else if (decision === "continue") overlay.resolveConfirm(true);
          return pending.then((value) => track(value));
        };
        if (schedule.overlayBeforeConfirm) {
          if (overlay.kind() !== "palette") trace.overlayStolen = true;
          overlay.dismiss();
        } else if (schedule.otherOverlay) {
          overlay.showModel();
          if (overlay.kind() !== "confirm") trace.overlayStolen = true;
        }
        if (schedule.ctrlC) {
          if (schedule.answerDelay === "delayed") {
            return (async () => {
              await new Promise((r) => setTimeout(r, 0));
              return applyCtrlC();
            })();
          }
          return applyCtrlC();
        }
        if (schedule.abortAt === "during-pause") abort.abort();
        if (schedule.answer === "never") {
          return pending.then((value) => {
            trace.overlayAfter = overlay.kind();
            return settle(value);
          });
        }
        const answer = async () => {
          if (schedule.answerDelay === "delayed") await new Promise((r) => setTimeout(r, 0));
          overlay.resolveConfirm(answerValue);
          const value = await pending;
          trace.overlayAfter = overlay.kind();
          return settle(value);
        };
        return answer();
      }
      if (schedule.abortAt === "during-pause") abort.abort();
      if (schedule.answer === "never") return new Promise<boolean>(() => {});
      if (schedule.answerDelay === "delayed") {
        if (signal?.aborted) return settle(false);
        return new Promise((resolve) => {
          const finish = (value: boolean) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(settle(value));
          };
          const onAbort = () => finish(false);
          const timer = setTimeout(() => finish(answerValue), 0);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return settle(answerValue);
    };

    let stdin: FakeStdin | null = null;
    let restoreIo: (() => void) | null = null;
    const sink: TurnUiSink = {
      onTextDelta: (delta) => trace.order.push(delta),
      onSystemLines: (lines) => trace.order.push(...lines),
      onError: (entry) => trace.errors.push(entry.message),
    };

    if (schedule.io === "memory") {
      if (schedule.hasHook) sink.onStepPause = memoryPause;
    } else {
      stdin = new FakeStdin();
      stdin.pause();
      trace.stdinBaseline = stdin.listenerCount("data");
      const originalStdin = process.stdin;
      const originalWrite = process.stdout.write;
      Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
      process.stdout.write = (() => true) as typeof process.stdout.write;
      const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      restoreIo = () => {
        Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
        process.stdout.write = originalWrite;
        if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
        stdin?.destroy();
      };
      const real = createDefaultTurnSink();
      sink.onStepPause = (steps, signal) => {
        trace.pauseCalls.push(steps);
        trace.signals.push(signal);
        trace.pending = true;
        return Promise.resolve(real.onStepPause!(steps, signal)).then((value) => {
          trace.pending = false;
          trace.focused = true;
          return value;
        });
      };
    }

    let outcome: { value?: string; error?: unknown } = {};
    let finished = false;
    let finishedOnNextTick: Promise<boolean> | undefined;
    abort.signal.addEventListener("abort", () => {
      finishedOnNextTick = new Promise((resolve) => setImmediate(() => resolve(finished)));
    }, { once: true });
    const histories = await historyArrays(userInput, async () => {
      const run = runTurnBounded(session, userInput, sink, abort.signal).then((result) => {
        finished = true;
        return result;
      });
      if (schedule.io !== "memory") {
        const deadline = Date.now() + 200;
        while (trace.pauseCalls.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 5));
        }
        if (schedule.io === "eof") stdin?.end();
        else abort.abort();
      }
      outcome = await run;
      if (overlay) {
        trace.overlayAfter = overlay.kind();
        trace.confirmLeft = overlay.kind() === "confirm" || overlay.confirmPrompt() !== null;
      }
      if (stdin) {
        trace.stdinListeners = stdin.listenerCount("data");
        trace.stdinPaused = stdin.isPaused();
      }
    });
    restoreIo?.();
    const elapsed = Date.now() - started;
    if (schedule.answer === "never" && schedule.abortAt === "during-pause") {
      expect(finishedOnNextTick).toBeDefined();
      expect(await finishedOnNextTick).toBe(true);
    }
    const threw = outcome.error && !(outcome.error instanceof TurnAbortedError) ? outcome.error : undefined;
    if (expectsAbort(schedule)) {
      expect(outcome.error).toBeInstanceOf(TurnAbortedError);
    } else if (outcome.error) {
      throw outcome.error;
    }

    const agentEvents = session.eventLog.readAll().slice(fromEvent).filter((event: any) => event.kind === "agent_message");
    expect(agentEvents).toHaveLength(1);
    const stored = String(agentEvents[0].payload.text).trim();
    if (outcome.error instanceof TurnAbortedError) {
      const partial = outcome.error.partialResponse.trim();
      expect(stored).toBe(partial ? `${partial}\n\n[interrupted]` : "[interrupted]");
    } else {
      expect(stored).toBe(outcome.value?.trim());
    }
    if (schedule.wrap === "interrupted") expect(stored).toContain("partial wrap");
    if (schedule.wrap === "success" && reachesWrap(schedule)) expect(stored).toContain("\n\n[summary] wrapped up");

    if (schedule.ctrlC) {
      expect(trace.wrapRequests).toBe(0);
      expect(trace.pauseSettles).toBe(1);
      expect(trace.overlayAfter).not.toBe("confirm");
      expect(trace.confirmLeft).toBe(false);
      expect(trace.focused).toBe(!schedule.otherOverlay);
    }
    checkI1(trace, schedule);
    checkI2(histories, session.eventLog.readAll(), fromEvent, schedule);
    checkI3(trace, schedule);
    checkI4(trace, schedule, threw);
    checkI5(trace, schedule, elapsed);
    overlay?.dispose();
  }
}

describe("step pause lifecycle", () => {
  it("I1-I6 hold for every seeded schedule", async () => {
    const root = join(homedir(), ".cache", "steps5-scratch");
    mkdirSync(root, { recursive: true });
    const logDir = mkdtempSync(join(root, "life-"));
    const failures: string[] = [];
    try {
      for (const seed of seedList()) {
        const schedule = buildSchedule(seed);
        try {
          await runSeed(schedule, logDir);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          failures.push(`seed=${seed} ctrlC=${schedule.ctrlC} ${detail}`);
        }
      }
      if (failures.length > 0) {
        throw new Error(`${failures.length} seeds failed\n${failures.slice(0, 8).join("\n")}`);
      }
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
