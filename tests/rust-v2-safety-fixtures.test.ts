// ============================================================
// PRAANA — Rust v2 Phase 0 legacy safety-hook and tool-result fixtures
//
// Drives the production hook handlers (plan → validate → risk → circuit →
// write-path, then lsp → verify → enrich → redact → circuit → release) with
// injected fakes. No workspace mutation, subprocess, prompt, or network.
// The committed fixtures are non-normative TypeScript observations; future
// behavior is owned by docs/RUST_V2_TOOL_RUNTIME_SPEC.md.
// ============================================================

import { afterAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

import {
  createBuiltinHookRegistry,
  createValidateHandlers,
  createVerifyPostToolCallHandler,
  HookRegistry,
  toolResultFromPreBlock,
  type HookSessionLike,
} from "../src/hooks/index.js";
import { createPlanModePreToolCallHandler } from "../src/hooks/handlers/plan-mode.js";
import { createLspEditHandlers } from "../src/hooks/handlers/lsp.js";
import {
  WritePathGuard,
  createWritePathPostToolCallHandler,
  createWritePathPreToolCallHandler,
} from "../src/hooks/handlers/write-path.js";
import { createCircuitHandlers } from "../src/hooks/handlers/circuit.js";
import { createRedactPostToolCallHandler } from "../src/hooks/handlers/redact.js";
import { createRiskPreToolCallHandler } from "../src/hooks/handlers/risk.js";
import { LoopGate } from "../src/circuit/loop-gate.js";
import type { LspManager } from "../src/lsp/manager.js";

const REPO_ROOT = join(import.meta.dir, "..");
const FIXTURE_ROOT = "tests/fixtures/rust-v2/safety";

/** Exact Section 5 inventory for the safety fixture family. */
const EXPECTED_INVENTORY = [
  "README.md",
  "manifest.json",
  "legacy-ts/pipeline/success.json",
  "legacy-ts/pipeline/plan-block.json",
  "legacy-ts/pipeline/validation-block.json",
  "legacy-ts/pipeline/risk-decline.json",
  "legacy-ts/pipeline/circuit-block.json",
  "legacy-ts/pipeline/write-conflict.json",
  "legacy-ts/pipeline/post-enrich-redact-release.json",
  "legacy-ts/tool-results/pre-block-with-suggestions.json",
  "legacy-ts/tool-results/success-redacted.json",
  "legacy-ts/tool-results/enriched-error-redacted.json",
  "legacy-ts/tool-results/post-handler-throw.json",
];

/** Production oracle files named in Section 4.4 (repo-relative). */
const ORACLE_FILES = [
  "src/circuit/loop-gate.ts",
  "src/hooks/block-result.ts",
  "src/hooks/handlers/circuit.ts",
  "src/hooks/handlers/lsp.ts",
  "src/hooks/handlers/plan-mode.ts",
  "src/hooks/handlers/redact.ts",
  "src/hooks/handlers/risk.ts",
  "src/hooks/handlers/validate.ts",
  "src/hooks/handlers/verify.ts",
  "src/hooks/handlers/write-path.ts",
  "src/hooks/index.ts",
  "src/hooks/registry.ts",
  "src/hooks/types.ts",
  "src/plan-mode.ts",
  "src/redact/secrets.ts",
  "src/risk/classes.ts",
  "src/risk/classify.ts",
  "src/session.ts",
  "src/turn.ts",
  "src/validate/fuzzy-path.ts",
  "src/validate/shell-check.ts",
];

const ORACLE_FILES_SORTED = [...ORACLE_FILES].sort();

// The workspace root is injected in already-sanitized form, so no path
// rewriting is ever needed inside fixtures.
const WORKSPACE = "/workspace/praana";
const MAIN_REL = "src/main.ts";
const MAIN_ABS = `${WORKSPACE}/${MAIN_REL}`;

function fixturePath(rel: string): string {
  return join(REPO_ROOT, FIXTURE_ROOT, rel);
}

function requireFixture(rel: string): string {
  const abs = fixturePath(rel);
  if (!existsSync(abs)) {
    throw new Error(`Missing fixture file: ${FIXTURE_ROOT}/${rel}`);
  }
  return readFileSync(abs, "utf8");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Recursively list files below the fixture root (repo-relative POSIX keys). */
function listFixtureFiles(): string[] {
  const rootAbs = join(REPO_ROOT, FIXTURE_ROOT);
  if (!existsSync(rootAbs)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        out.push(relative(rootAbs, abs).split("\\").join("/"));
      }
    }
  };
  walk(rootAbs);
  return out.sort();
}

// ── Fakes ────────────────────────────────────────────────────

interface LoggerRecord {
  hook: string;
  message: string;
  error: string;
}

function makeLoggerFake() {
  const records: LoggerRecord[] = [];
  return {
    records,
    value: {
      child(_domain: string) {
        return {
          warn(message: string, opts?: Record<string, unknown>) {
            const details = (opts?.details ?? {}) as { hook?: string; error?: string };
            // Records only the hook point, safe message, and safe error text.
            // Excludes Error.cause, stack, timestamp, and host paths.
            records.push({
              hook: String(details.hook ?? ""),
              message: String(message),
              error: String(details.error ?? ""),
            });
          },
        };
      },
    },
  };
}

interface FakeLspManager {
  enabled: boolean;
  diagnosticsEnabled: boolean;
  formatOnEdit: boolean;
  snapshotDiagnostics(absPath: string): Promise<unknown[]>;
  diagnostics(absPath: string): Promise<{ ok: boolean; value: unknown[] }>;
  format(absPath: string): Promise<{ ok: boolean; value: { changed: boolean; skipped?: string } }>;
  setApplyLock(lock: unknown): void;
}

function makeLspFake(): FakeLspManager {
  return {
    enabled: true,
    diagnosticsEnabled: true,
    formatOnEdit: false,
    snapshotDiagnostics: async () => [],
    diagnostics: async () => ({ ok: true, value: [] }),
    format: async () => ({ ok: false, value: { changed: false } }),
    setApplyLock: () => {},
  };
}

interface SessionFakeOptions {
  planMode?: boolean;
  hasReadPaths?: string[];
  readIndexActive?: boolean;
  recentWrites?: Array<{ path: string; turn?: number }>;
  confirmRiskResult?: { allowed: true } | { allowed: false; reason: "declined" | "headless" };
  loopGate?: LoopGate;
  logger?: ReturnType<typeof makeLoggerFake>["value"];
}

function makeSessionFake(opts: SessionFakeOptions = {}): HookSessionLike {
  const readPaths = opts.hasReadPaths ?? [];
  const active = opts.readIndexActive ?? true;
  return {
    cwd: WORKSPACE,
    isPlanMode: () => opts.planMode ?? false,
    getLogger: () => opts.logger,
    hasReadPath: (abs: string) => (active ? readPaths.includes(abs) : null),
    listReadPaths: () => [...readPaths],
    recentWritesForPath: () => opts.recentWrites ?? [],
    confirmRisk: async () => opts.confirmRiskResult ?? { allowed: false, reason: "declined" },
    observeCircuitPre: opts.loopGate
      ? (tool: string, args: Record<string, unknown>) => opts.loopGate!.observePre(tool, args)
      : undefined,
    observeCircuitPost: opts.loopGate
      ? (tool: string, args: Record<string, unknown>, isError: boolean) =>
          opts.loopGate!.observePost(tool, args, isError)
      : undefined,
    circuitNotes: opts.loopGate ? () => opts.loopGate!.notes() : undefined,
  };
}

interface ValidateDeps {
  pathExists: (absPath: string) => boolean;
  listRepoFiles: () => string[];
  commandOnPath: (name: string) => boolean;
}

function makeValidateDeps(existingAbsPaths: string[] = [MAIN_ABS]): ValidateDeps {
  return {
    pathExists: (abs: string) => existingAbsPaths.includes(abs),
    listRepoFiles: () => [`${WORKSPACE}/src/main.ts`, `${WORKSPACE}/src/helper.ts`],
    commandOnPath: () => true,
  };
}

// ── Traced mirror of the production registration order ──────
//
// Uses the exact production handler factories registered in the exact order of
// registerBuiltinHooks (src/hooks/index.ts), wrapped with an observer that
// records each completed stage. The manifest binds src/hooks/index.ts by hash,
// so registration drift is detectable. A cross-check test also compares a plain
// createBuiltinHookRegistry dispatch against this mirror for the success case.

interface MirrorOptions {
  cwd: string;
  validateDeps: ValidateDeps;
  lsp?: FakeLspManager | null;
  verifyConfig?: unknown;
  failingPostHandler?: boolean;
}

interface MirrorResult {
  registry: HookRegistry;
  guard: WritePathGuard;
  trace: string[];
}

function tracedMirror(opts: MirrorOptions): MirrorResult {
  const registry = new HookRegistry();
  const guard = new WritePathGuard(opts.cwd);
  const trace: string[] = [];

  const pre =
    <C, R>(name: string, handler: (ctx: C) => R) =>
    async (ctx: C): Promise<Awaited<R>> => {
      const result = await handler(ctx);
      trace.push(name);
      return result as Awaited<R>;
    };
  const post =
    <C, R>(name: string, handler: (ctx: C) => R) =>
    async (ctx: C): Promise<Awaited<R>> => {
      const result = await handler(ctx);
      trace.push(name);
      return result as Awaited<R>;
    };

  // Mirrors registerBuiltinHooks (src/hooks/index.ts) exactly:
  // pre = plan → validate → risk → circuit → write-path acquire → lsp snapshot
  // post = lsp post-edit → verify → enrich → redact → circuit → write-path release
  registry.onPreToolCall(pre("plan", createPlanModePreToolCallHandler()));
  const validate = createValidateHandlers({
    cwd: opts.cwd,
    pathExists: opts.validateDeps.pathExists,
    listRepoFiles: opts.validateDeps.listRepoFiles,
    commandOnPath: opts.validateDeps.commandOnPath,
  });
  registry.onPreToolCall(pre("validate", validate.pre));
  registry.onPreToolCall(pre("risk", createRiskPreToolCallHandler(opts.cwd)));
  const circuit = createCircuitHandlers();
  registry.onPreToolCall(pre("circuit", circuit.pre));
  registry.onPreToolCall(pre("write_path", createWritePathPreToolCallHandler(guard)));

  if (opts.lsp) {
    opts.lsp.setApplyLock({
      tryAcquireExtra: (id: string, absPath: string) =>
        guard.tryAcquireExtra(id, absPath, absPath),
    });
    const lspHandlers = createLspEditHandlers({
      cwd: opts.cwd,
      getLsp: () => opts.lsp as unknown as LspManager,
      onFormattedPath: undefined,
    });
    registry.onPreToolCall(pre("lsp_snapshot", lspHandlers.pre));
    if (opts.failingPostHandler) {
      registry.onPostToolCall(async () => {
        throw new Error("post-handler-fixture-failure");
      });
    }
    registry.onPostToolCall(post("lsp", lspHandlers.post));
  }

  registry.onPostToolCall(
    post(
      "verify",
      createVerifyPostToolCallHandler({
        cwd: opts.cwd,
        getConfig: () => opts.verifyConfig as never,
      }),
    ),
  );
  registry.onPostToolCall(post("enrich", validate.post));
  registry.onPostToolCall(post("redact", createRedactPostToolCallHandler()));
  registry.onPostToolCall(post("circuit_accounting", circuit.post));
  registry.onPostToolCall(post("write_path_release", createWritePathPostToolCallHandler(guard)));

  return { registry, guard, trace };
}

// ── Pipeline runner ──────────────────────────────────────────

interface PipelineObservation {
  scenario: string;
  tool_name: string;
  args: Record<string, unknown>;
  pre_trace: string[];
  execute: "ran" | "skipped";
  post_trace: string[];
  dispatch: {
    pre: unknown;
    post: { result: unknown; isError: boolean } | null;
  };
  result: unknown;
}

type ToolResultObservation = PipelineObservation & { logged_errors?: LoggerRecord[] };

interface RunPipelineOptions {
  scenario: string;
  toolName: string;
  args: Record<string, unknown>;
  session: HookSessionLike;
  validateDeps: ValidateDeps;
  body?: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  lsp?: FakeLspManager | null;
  verifyConfig?: unknown;
  failingPostHandler?: boolean;
  preholdLease?: { abs: string; rel: string };
  loopGate?: LoopGate;
}

async function runPipeline(opts: RunPipelineOptions): Promise<{
  observation: PipelineObservation;
  guard: WritePathGuard;
  loggerRecords: LoggerRecord[];
}> {
  const logger = makeLoggerFake();
  const session: HookSessionLike = { ...opts.session, getLogger: () => logger.value };
  const mirror = tracedMirror({
    cwd: WORKSPACE,
    validateDeps: opts.validateDeps,
    lsp: opts.lsp ?? null,
    verifyConfig: opts.verifyConfig,
    failingPostHandler: opts.failingPostHandler,
  });

  if (opts.preholdLease) {
    mirror.guard.tryAcquire(opts.preholdLease.abs, opts.preholdLease.rel);
  }

  const pre = await mirror.registry.runPreToolCall({
    toolName: opts.toolName,
    args: opts.args,
    session,
  });
  const preTrace = mirror.trace.slice();

  let execute: "ran" | "skipped" = "skipped";
  let result: unknown;
  let postDispatch: { result: unknown; isError: boolean } | null = null;

  if (pre.action === "block") {
    result = toolResultFromPreBlock(pre);
  } else {
    execute = "ran";
    let bodyResult: unknown;
    let isError = false;
    try {
      bodyResult = opts.body ? await opts.body(pre.args) : { ok: true };
    } catch (err) {
      isError = true;
      bodyResult = { ok: false, error: (err as Error)?.message ?? "Tool execution failed" };
    }
    const post = await mirror.registry.runPostToolCall({
      toolName: opts.toolName,
      args: pre.args,
      result: bodyResult,
      isError,
      session,
    });
    postDispatch = { result: post.result, isError: post.isError };
    result = post.result;
  }

  const observation: PipelineObservation = {
    scenario: opts.scenario,
    tool_name: opts.toolName,
    args: opts.args,
    pre_trace: preTrace,
    execute,
    post_trace: mirror.trace.slice(preTrace.length),
    dispatch: { pre, post: postDispatch },
    result,
  };
  return { observation, guard: mirror.guard, loggerRecords: logger.records };
}

// ── Shared scenario inputs ───────────────────────────────────

const EDIT_ARGS = { path: MAIN_REL, old_text: "alpha", new_text: "beta" };
const CANARY_AWS = "AKIAIOSFODNN7EXAMPLE";

function baseSession(extra: SessionFakeOptions = {}): HookSessionLike {
  return makeSessionFake({ hasReadPaths: [MAIN_ABS], ...extra });
}

// ── runTurn harness (module mocks, mirrors tests/turn.test.ts) ──

const mockStream = mock();
const ceReal = { ...(await import("../src/context-engine/index.js")) };
const ccReal = { ...(await import("../src/compile-classic.js")) };
const llmReal = { ...(await import("../src/llm.js")) };
const toolsReal = { ...(await import("../src/tools/index.js")) };
const autoCompactReal = { ...(await import("../src/auto-compact.js")) };
const uiReal = { ...(await import("../src/ui.js")) };
const nativeLlmReal = { ...(await import("../src/llm/index.js")) };
const zodReal = { ...(await import("zod-to-json-schema")) };

mock.module("../src/llm/index.js", () => ({
  ...nativeLlmReal,
  streamLlmResponse: mockStream,
}));
mock.module("zod-to-json-schema", () => ({
  zodToJsonSchema: mock(() => ({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    definitions: {},
  })),
}));
mock.module("../src/compiler.js", () => ({}));
mock.module("../src/context-engine/index.js", () => ({
  ...ceReal,
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

const toolBodyMock = mock();
mock.module("../src/tools/index.js", () => ({
  createAllTools: mock(() => ({
    edit_file: {
      description: "Edit a file",
      parameters: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
      execute: toolBodyMock,
    },
  })),
  describeTools: mock(() => ["edit_file(path, old_text, new_text) — Edit a file"]),
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

// Registers the module-mock teardown when running under the test runner.
// The one-off fixture capture script imports this module outside `bun test`,
// where lifecycle registration is unavailable; mocking still applies live.
try {
  afterAll(() => {
    mock.module("../src/context-engine/index.js", () => ceReal);
    mock.module("../src/compile-classic.js", () => ccReal);
    mock.module("../src/llm.js", () => llmReal);
    mock.module("../src/tools/index.js", () => toolsReal);
    mock.module("../src/auto-compact.js", () => autoCompactReal);
    mock.module("../src/ui.js", () => uiReal);
    mock.module("../src/llm/index.js", () => nativeLlmReal);
    mock.module("zod-to-json-schema", () => zodReal);
    mock.module("../src/compiler.js", () => ({}));
  });
} catch {
  // outside the test runner
}

const piStream = mockStream;
import { runTurn } from "../src/turn.js";
import { StateGraph } from "../src/state-graph.js";
import { createNullScorecard } from "../src/context-engine/telemetry.js";

const TURN_ARGS = { path: "src/maiin.ts", old_text: "alpha", new_text: "beta" };

function makeTurnConfig(): any {
  return {
    llm: { provider: "openrouter", model: "fixture-model" },
    memory: {
      enabled: false,
      summarizer: "openrouter",
      db_path: ":memory:",
      embedder: "auto",
      ollama_url: "http://localhost:11434",
      ollama_model: "nomic-embed-text",
    },
    compiler: { token_budget: 100_000, recent_turns: 10, recent_turns_token_budget: 30_000 },
    tiers: { idle_soft_after_turns: 3, idle_hard_after_turns: 6 },
    session: { log_dir: "/tmp/praana-test" },
    consolidation: { enabled: false, promotion_threshold: 3, run_delay_seconds: 30 },
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
  };
}

function makeTurnSession(hooks: unknown, eventLog: unknown): any {
  const config = makeTurnConfig();
  const stateGraph = new StateGraph();
  const loopGate = new LoopGate({ threshold: 3 });
  const session: any = {
    id: "fixture-safety-session",
    cwd: WORKSPACE,
    hooks,
    confirmRisk: async () => ({ allowed: true }),
    loopGate,
    observeCircuitPre: (tool: string, args: Record<string, unknown>) => loopGate.observePre(tool, args),
    observeCircuitPost: (tool: string, args: Record<string, unknown>, isError: boolean) =>
      loopGate.observePost(tool, args, isError),
    circuitNotes: () => loopGate.notes(),
    getStartedAt: () => 0,
    config,
    eventLog,
    stateGraph,
    memoryStore: null,
    memoryEnabled: false,
    incognito: true,
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
    persistStateGraphCheckpoint: () => {},
    getTurnCount() {
      return this._turnCount;
    },
    getLastResetBoundaryTurn() {
      return -1;
    },
    getVisibleSessionCheckpoint() {
      return undefined;
    },
    getMemoryStats() {
      return { total: 0, active: 0, soft: 0, hard: 0, byKind: {} };
    },
    setLastCompileMetrics(m: unknown) {
      this._lastCompileMetrics = m;
    },
    getLastCompileMetrics() {
      return this._lastCompileMetrics;
    },
    setLastCompileScoreRecords() {},
    getLastCompileScoreRecords() {
      return [];
    },
    getCompileScoreRecord() {
      return undefined;
    },
    getLastPressureMode() {
      return "normal";
    },
    getLastPressureRatio() {
      return 0;
    },
    getLastWeightedTokens() {
      return 0;
    },
    getLastRawPressureRatio() {
      return 0;
    },
    getDisplayContextSnapshot() {
      return null;
    },
    setDisplayContextSnapshot() {},
    setLastKnownTaskType() {},
    setLastUserInput() {},
    getLastUserInput() {
      return "";
    },
    isIncognito() {
      return true;
    },
    isContextEngineEnabled() {
      return false;
    },
    planMode: false,
    enterPlanMode() {
      this.planMode = true;
    },
    exitPlanMode() {
      this.planMode = false;
    },
    isPlanMode() {
      return this.planMode;
    },
    hasReadPath: () => null,
    listReadPaths: () => [],
    recentWritesForPath: () => [],
    skills: [],
    recordInputTokens() {},
    recordOutputTokens() {},
    getInputTokens() {
      return 0;
    },
    getOutputTokens() {
      return 0;
    },
    ensureModelContextWindow: async () => 128_000,
    getContextWindowTokens: () => 128_000,
    getEffectiveProvider() {
      return config.llm.provider;
    },
    getEffectiveLlmConfig() {
      return config.llm;
    },
    getActiveModelId() {
      return config.llm.model;
    },
    getActiveModelLabel() {
      return `${config.llm.provider}/${config.llm.model}`;
    },
    getEffectiveReasoningEffort() {
      return "medium";
    },
    recordReasoningEffortUsed() {},
    getLastReasoningEffortUsed() {
      return null;
    },
    isCompactionArmed: () => false,
    setCompactionArmed() {},
    getLogger() {
      return undefined;
    },
    getModelOverride() {
      return undefined;
    },
    setModelOverride() {},
    getProviderOverride() {
      return undefined;
    },
    setProviderOverride() {},
    embeddingCache: null,
    nativeStatus: "unavailable",
    projectContext: null,
    lspManager: null,
    headless: false,
  };
  return session;
}

async function captureRunTurnPreBlock(): Promise<ToolResultObservation> {
  toolBodyMock.mockImplementation(async () => {
    throw new Error("tool body must never run for a pre-block");
  });
  const validateDeps = makeValidateDeps([MAIN_ABS]);
  const mirror = tracedMirror({ cwd: WORKSPACE, validateDeps, lsp: null });

  const events: Array<Record<string, unknown>> = [];
  const eventLog = {
    append: (ev: Record<string, unknown>) => {
      events.push(ev);
    },
    readLast: () => events.slice(-1),
    readAll: () => events.slice(),
    readLastUncompressed: () => events.slice(),
    readAllUncompressed: () => events.slice(),
    readLastUncompressedAfterResetBoundary: () => events.slice(),
    readAllUncompressedAfterResetBoundary: () => events.slice(),
    search: () => [],
  };
  const captured: { pre: unknown; post: unknown; preTrace: string[] } = {
    pre: null,
    post: null,
    preTrace: [],
  };
  const hooks = {
    runPreToolCall: (ctx: Parameters<HookRegistry["runPreToolCall"]>[0]) => {
      return mirror.registry.runPreToolCall(ctx).then((r) => {
        if (captured.pre === null) {
          captured.pre = r;
          captured.preTrace = mirror.trace.slice();
        }
        return r;
      });
    },
    runPostToolCall: (...a: Parameters<HookRegistry["runPostToolCall"]>) =>
      mirror.registry.runPostToolCall(...a),
    runPreCompile: (...a: Parameters<HookRegistry["runPreCompile"]>) =>
      mirror.registry.runPreCompile(...a),
    runPostTurn: (...a: Parameters<HookRegistry["runPostTurn"]>) =>
      mirror.registry.runPostTurn(...a),
  };
  const session = makeTurnSession(hooks, eventLog);

  const stream = piStream as unknown as ReturnType<typeof mock>;
  stream.mockImplementationOnce(async function* () {
    yield {
      type: "tool_call_end",
      toolCall: { id: "call-fixture-0001", name: "edit_file", args: TURN_ARGS },
    };
    yield {
      type: "done",
      reason: "tool_use",
      message: { role: "assistant", content: [], toolCalls: [] },
    };
  });
  stream.mockImplementation(async function* () {
    yield {
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    };
  });

  await runTurn(session, "edit src/maiin.ts");

  const toolResultEvent = events.find((ev) => ev.kind === "tool_result") as {
    payload: { result: unknown };
  };
  if (!toolResultEvent) throw new Error("runTurn published no tool_result event");

  return {
    scenario: "pre-block-with-suggestions",
    tool_name: "edit_file",
    args: TURN_ARGS,
    pre_trace: captured.preTrace,
    execute: "skipped",
    post_trace: [],
    dispatch: { pre: captured.pre, post: null },
    result: toolResultEvent.payload.result,
  };
}

interface CapturedScenarios {
  pipeline: Record<string, PipelineObservation>;
  toolResults: Record<string, ToolResultObservation>;
}

async function captureAllScenarios(): Promise<CapturedScenarios> {
  const pipeline: Record<string, PipelineObservation> = {};

  // 1. success — all stages, LSP snapshot after lock, release last.
  {
    const { observation, guard } = await runPipeline({
      scenario: "success",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession(),
      validateDeps: makeValidateDeps(),
      body: () => ({ ok: true, content: "updated main" }),
      lsp: makeLspFake(),
    });
    expect(observation.execute).toBe("ran");
    expect(observation.pre_trace).toEqual([
      "plan",
      "validate",
      "risk",
      "circuit",
      "write_path",
      "lsp_snapshot",
    ]);
    expect(observation.post_trace).toEqual([
      "lsp",
      "verify",
      "enrich",
      "redact",
      "circuit_accounting",
      "write_path_release",
    ]);
    expect(guard.has(MAIN_ABS)).toBe(false);
    pipeline.success = observation;
  }

  // 2. plan-block — plan blocks first; everything after is absent.
  {
    const { observation } = await runPipeline({
      scenario: "plan-block",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession({ planMode: true, hasReadPaths: [MAIN_ABS] }),
      validateDeps: makeValidateDeps(),
      lsp: null,
      body: () => {
        throw new Error("body must never run in plan-block");
      },
    });
    expect(observation.pre_trace).toEqual(["plan"]);
    expect(observation.post_trace).toEqual([]);
    pipeline["plan-block"] = observation;
  }

  // 3. validation-block — validate blocks before risk, circuit, lock, body, post.
  {
    const { observation } = await runPipeline({
      scenario: "validation-block",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession({ hasReadPaths: [] }),
      validateDeps: makeValidateDeps(),
      lsp: null,
      body: () => {
        throw new Error("body must never run in validation-block");
      },
    });
    expect(observation.pre_trace).toEqual(["plan", "validate"]);
    expect(observation.post_trace).toEqual([]);
    pipeline["validation-block"] = observation;
  }

  // 4. risk-decline — risk runs after validation and blocks before circuit.
  {
    const { observation } = await runPipeline({
      scenario: "risk-decline",
      toolName: "shell",
      args: { command: "rm -rf build" },
      session: baseSession({ hasReadPaths: [] }),
      validateDeps: makeValidateDeps(),
      lsp: null,
      body: () => {
        throw new Error("body must never run in risk-decline");
      },
    });
    expect(observation.pre_trace).toEqual(["plan", "validate", "risk"]);
    expect(observation.post_trace).toEqual([]);
    pipeline["risk-decline"] = observation;
  }

  // 5. circuit-block — circuit runs after risk and blocks before lock/body/post.
  {
    const loopGate = new LoopGate({ threshold: 3 });
    loopGate.observePre("edit_file", EDIT_ARGS);
    loopGate.observePre("edit_file", EDIT_ARGS);
    const { observation } = await runPipeline({
      scenario: "circuit-block",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession({ hasReadPaths: [MAIN_ABS], loopGate }),
      validateDeps: makeValidateDeps(),
      lsp: null,
      body: () => {
        throw new Error("body must never run in circuit-block");
      },
    });
    expect(observation.pre_trace).toEqual(["plan", "validate", "risk", "circuit"]);
    expect(observation.post_trace).toEqual([]);
    pipeline["circuit-block"] = observation;
  }

  // 6. write-conflict — write-path is the final pre stage with a non-error block.
  {
    const { observation, guard } = await runPipeline({
      scenario: "write-conflict",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession({ hasReadPaths: [MAIN_ABS] }),
      validateDeps: makeValidateDeps(),
      lsp: null,
      body: () => {
        throw new Error("body must never run in write-conflict");
      },
      preholdLease: { abs: MAIN_ABS, rel: MAIN_REL },
    });
    expect(observation.pre_trace).toEqual(["plan", "validate", "risk", "circuit", "write_path"]);
    expect(observation.post_trace).toEqual([]);
    expect(guard.has(MAIN_ABS)).toBe(true);
    pipeline["write-conflict"] = observation;
  }

  // 7. post-enrich-redact-release — enrichment redacted, accounting sees the
  //    final error flag, lease released last.
  {
    const { observation, guard } = await runPipeline({
      scenario: "post-enrich-redact-release",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession({ hasReadPaths: [MAIN_ABS] }),
      validateDeps: makeValidateDeps(),
      lsp: null,
      body: () => {
        throw new Error(`edit failed while writing ${CANARY_AWS} to src/main.ts`);
      },
    });
    expect(observation.execute).toBe("ran");
    expect(observation.post_trace).toEqual([
      "verify",
      "enrich",
      "redact",
      "circuit_accounting",
      "write_path_release",
    ]);
    expect(guard.has(MAIN_ABS)).toBe(false);
    pipeline["post-enrich-redact-release"] = observation;
  }

  const toolResults: Record<string, ToolResultObservation> = {};

  // A. pre-block-with-suggestions — through the full runTurn orchestration.
  toolResults["pre-block-with-suggestions"] = await captureRunTurnPreBlock();

  // B. success-redacted — a successful result containing a secret canary.
  {
    const { observation } = await runPipeline({
      scenario: "success-redacted",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession({ hasReadPaths: [MAIN_ABS] }),
      validateDeps: makeValidateDeps(),
      lsp: null,
      body: () => ({
        ok: true,
        content: `updated ${CANARY_AWS} in src/main.ts`,
      }),
    });
    toolResults["success-redacted"] = observation;
  }

  // C. enriched-error-redacted — failed result enriched, then redacted.
  {
    const { observation } = await runPipeline({
      scenario: "enriched-error-redacted",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession({ hasReadPaths: [MAIN_ABS] }),
      validateDeps: makeValidateDeps(),
      lsp: null,
      body: () => ({
        ok: false,
        error: `edit failed while writing ${CANARY_AWS}`,
      }),
    });
    toolResults["enriched-error-redacted"] = observation;
  }

  // D. post-handler-throw — a thrown post handler is logged and later handlers continue.
  {
    const { observation, loggerRecords } = await runPipeline({
      scenario: "post-handler-throw",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession({ hasReadPaths: [MAIN_ABS] }),
      validateDeps: makeValidateDeps(),
      lsp: makeLspFake(),
      failingPostHandler: true,
      body: () => ({ ok: true, content: "updated main" }),
    });
    expect(loggerRecords.length).toBe(1);
    expect(loggerRecords[0].error).toBe("post-handler-fixture-failure");
    toolResults["post-handler-throw"] = { ...observation, logged_errors: loggerRecords };
  }

  return { pipeline, toolResults };
}

// ── Static fixture assertions ────────────────────────────────

describe("rust-v2 safety legacy fixtures", () => {
  it("safety fixture inventory is complete", () => {
    const present = new Set(listFixtureFiles());
    const missing = EXPECTED_INVENTORY.filter((rel) => !present.has(rel));
    const extra = [...present].filter((rel) => !EXPECTED_INVENTORY.includes(rel));
    expect(missing, `Missing safety fixtures: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `Unexpected extra safety fixture files: ${extra.join(", ")}`).toEqual([]);
  });

  it("safety manifest is complete, sorted, and hash-bound", () => {
    const manifest = JSON.parse(requireFixture("manifest.json")) as {
      fixture_schema_version: number;
      fixture_kind: string;
      oracle_sha256_by_file: Record<string, string>;
      fixture_sha256_by_file: Record<string, string>;
    };

    expect(manifest.fixture_schema_version).toBe(1);
    expect(manifest.fixture_kind).toBe("legacy-typescript-safety");

    const oracleKeys = Object.keys(manifest.oracle_sha256_by_file);
    expect(oracleKeys).toEqual(ORACLE_FILES_SORTED);
    for (const rel of ORACLE_FILES_SORTED) {
      const bytes = readFileSync(join(REPO_ROOT, rel));
      expect(manifest.oracle_sha256_by_file[rel], `oracle hash mismatch: ${rel}`).toBe(
        sha256Hex(bytes),
      );
    }

    const fixtureKeys = Object.keys(manifest.fixture_sha256_by_file);
    const diskFiles = listFixtureFiles().filter((rel) => rel !== "manifest.json");
    expect(fixtureKeys).toEqual(diskFiles);
    for (const rel of fixtureKeys) {
      const bytes = readFileSync(fixturePath(rel));
      expect(manifest.fixture_sha256_by_file[rel], `fixture hash mismatch: ${rel}`).toBe(
        sha256Hex(bytes),
      );
    }
  });

  it("pipeline fixtures are deterministic across a double run", async () => {
    const first = await captureAllScenarios();
    const second = await captureAllScenarios();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("legacy pipeline scenarios match committed evidence", async () => {
    const captured = await captureAllScenarios();
    for (const [scenario, observation] of Object.entries(captured.pipeline)) {
      const committed = JSON.parse(requireFixture(`legacy-ts/pipeline/${scenario}.json`));
      expect(committed, `pipeline fixture mismatch: ${scenario}`).toEqual(observation);
    }
  });

  it("tool-result fixtures match committed evidence", async () => {
    const captured = await captureAllScenarios();
    for (const [name, observation] of Object.entries(captured.toolResults)) {
      const committed = JSON.parse(requireFixture(`legacy-ts/tool-results/${name}.json`));
      expect(committed, `tool-result fixture mismatch: ${name}`).toEqual(observation);
    }
  });

  it("success dispatch matches the production createBuiltinHookRegistry", async () => {
    const validateDeps = makeValidateDeps();
    const session = baseSession();
    const production = createBuiltinHookRegistry(WORKSPACE, {
      lspManager: makeLspFake() as unknown as LspManager,
      validate: {
        pathExists: validateDeps.pathExists,
        listRepoFiles: validateDeps.listRepoFiles,
        commandOnPath: validateDeps.commandOnPath,
      },
    });
    const pre = await production.runPreToolCall({
      toolName: "edit_file",
      args: EDIT_ARGS,
      session,
    });
    const post = await production.runPostToolCall({
      toolName: "edit_file",
      args: EDIT_ARGS,
      result: { ok: true, content: "updated main" },
      isError: false,
      session,
    });

    const mirror = await runPipeline({
      scenario: "success",
      toolName: "edit_file",
      args: EDIT_ARGS,
      session: baseSession(),
      validateDeps: makeValidateDeps(),
      body: () => ({ ok: true, content: "updated main" }),
      lsp: makeLspFake(),
    });
    expect(pre).toEqual(mirror.observation.dispatch.pre);
    expect(post).toEqual(mirror.observation.dispatch.post);
  });

  it("safety fixtures contain no credentials or machine-specific values", () => {
    for (const rel of listFixtureFiles()) {
      const raw = readFileSync(fixturePath(rel), "latin1");
      if (raw.includes("\r")) {
        throw new Error(`${rel}: contains CR`);
      }
      if (raw.includes("-----BEGIN")) {
        throw new Error(`${rel}: contains a PEM delimiter`);
      }
      if (/AKIA[A-Z0-9]{16}/.test(raw)) {
        throw new Error(`${rel}: contains an unredacted AWS access key canary`);
      }
      if (/sk-[A-Za-z0-9_-]{20,}/.test(raw)) {
        throw new Error(`${rel}: contains an unredacted secret key canary`);
      }
      if (/[A-Za-z]:\\/.test(raw)) {
        throw new Error(`${rel}: contains a Windows absolute path`);
      }
      if (raw.includes("/home/") || raw.includes("/Users/") || raw.includes("/tmp/")) {
        throw new Error(`${rel}: contains a machine-specific absolute path`);
      }
      if (rel.endsWith(".json")) {
        if (/\bNaN\b/.test(raw) || /\bInfinity\b/.test(raw)) {
          throw new Error(`${rel}: contains a non-finite number`);
        }
      }
    }
  });
});

void CANARY_AWS;

export { captureAllScenarios };
