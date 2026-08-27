import { describe, it, expect, beforeEach, afterEach, afterAll, mock, type Mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AppController } from "../src/app-controller.js";
import type { CliArgs } from "../src/cli-args.js";
import type { PraanaConfig } from "../src/types.js";
import * as sessionActual from "../src/session.js";
import { Session } from "../src/session.js";
import * as turnActual from "../src/turn.js";
import { runTurn } from "../src/turn.js";
import { TurnAbortedError } from "../src/turn-control.js";
import { getUserSettingsPath, saveUserSettings } from "../src/user-settings.js";
import { APP_HOME_DIR } from "../src/app-identity.js";

// Snapshot real module BEFORE mock.module updates live bindings
const sessionReal = { ...sessionActual };
const turnReal = { ...turnActual };

mock.module("../src/turn.js", () => ({
  ...turnReal,
  runTurn: mock(async () => {
    throw new TurnAbortedError("partial output");
  }),
}));

mock.module("../src/session.js", () => ({
  Session: {
    create: mock(async () => ({
      id: "sess-1",
      cwd: "/tmp",
      debug: false,
      config: { llm: { provider: "openrouter", model: "test/model" } },
      getModelOverride: () => null,
      getProviderOverride: () => null,
      setModelOverride: mock(),
      setProviderOverride: mock(),
      setIncognito: mock(async () => {}),
      getActiveModelId: () => "test/model",
      getActiveModelLabel: () => "openrouter/test/model",
      getEffectiveProvider: () => "openrouter",
      getContextWindowTokens: () => 128_000,
      refreshModelContextWindow: mock(async () => 128_000),
      getMemoryStats: () => ({
        total: 0,
        active: 0,
        soft: 0,
        hard: 0,
        byKind: {},
      }),
      getRepoRoot: () => "/tmp",
      getGitBranch: () => null,
      memoryEnabled: false,
      isIncognito: () => false,
      isPlanMode: () => false,
      digest: null,
      agentsContext: null,
      skills: [],
      skillRuntime: null,
      getLastCompileMetrics: () => null,
      getLastWeightedTokens: () => 0,
      getLastPressureMode: () => "normal" as const,
      getLastRawPressureRatio: () => 0,
      getDisplayContextSnapshot: () => null,
      isContextEngineEnabled: () => false,
      getStartedAt: () => Date.now(),
      getUptimeMs: () => 0,
      getTurnCount: () => 0,
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getPersistentMemoryEntryCount: () => 0,
      getMemoryDbPath: () => null,
      stateGraph: { list: () => [] },
      eventLog: { readLast: () => [] },
      end: mock(async () => ({ memory: "skipped" as const })),
      getTranscriptEvents: () => [],
    })),
    resume: mock(),
  },
}));

const baseConfig: PraanaConfig = {
  llm: { provider: "openrouter", model: "test/model" },
  memory: { enabled: false, summarizer: "disabled", db_path: ":memory:" },
  compiler: {
    token_budget: 100_000,
    recent_turns: 10,
    recent_turns_token_budget: 30_000,
  },
  tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
  session: { log_dir: "/tmp/praana-test" },
  ui: { markdown_rendering: true, syntax_highlighting: true, syntax_theme: "nord", ambient: "inline", tool_icons: "unicode", background_zones: true, show_cost: true, banner: true },
};

const baseParsed: CliArgs = {
  sessionId: null,
  resumeMode: false,
  debug: false,
  incognito: false,
  configPath: undefined,
  showHelp: false,
  force: false,
  initMode: false,
  memoryDedupeMode: false,
};

describe("AppController", () => {
  const originalPraanaHome = process.env.PRAANA_HOME;
  let praanaHome: string;

  beforeEach(() => {
    mock.clearAllMocks();
    praanaHome = join(tmpdir(), `praana-ac-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(praanaHome, APP_HOME_DIR), { recursive: true });
    process.env.PRAANA_HOME = praanaHome;
  });

  afterEach(() => {
    if (originalPraanaHome !== undefined) {
      process.env.PRAANA_HOME = originalPraanaHome;
    } else {
      delete process.env.PRAANA_HOME;
    }
    try {
      rmSync(praanaHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("starts a session and exposes status bar input", async () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    const info = await controller.start();
    expect(info.session.id).toBe("sess-1");
    expect(info.bannerLines.some((l) => l.includes("sess-1"))).toBe(true);
    const status = controller.getStatusBarInput();
    expect(status.model).toBe("openrouter/test/model");
  });

  it("delegates slash commands with structured results", async () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    await controller.start();
    const result = await controller.executeSlashCommand("/help");
    expect(result.action).toBe("none");
    expect(result.lines.length).toBeGreaterThan(0);
  });

  it("shutdown() returns the memory status from session.end() and passes a default 2s timeout", async () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    await controller.start();
    const end = controller.session.end as ReturnType<typeof mock>;
    end.mockResolvedValueOnce({
      memory: "background",
      turns: 0,
      stateObjects: 0,
      rememberCalls: 0,
      recallUsed: 0,
      learningsStored: 0,
    });

    const status = await controller.shutdown();
    expect(status.memory).toBe("background");
    expect(end).toHaveBeenCalledWith("clean", [], { memoryTimeoutMs: 2_000 });
  });

  it("shutdown() honours config.session.shutdown_memory_timeout_ms when set", async () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: { ...baseConfig, session: { ...baseConfig.session, shutdown_memory_timeout_ms: 500 } },
      parsed: baseParsed,
    });
    await controller.start();
    const end = controller.session.end as ReturnType<typeof mock>;
    end.mockResolvedValueOnce({
      memory: "completed",
      turns: 1,
      stateObjects: 0,
      rememberCalls: 0,
      recallUsed: 0,
      learningsStored: 2,
    });

    const status = await controller.shutdown();
    expect(status.memory).toBe("completed");
    expect(status.learningsStored).toBe(2);
    expect(end).toHaveBeenCalledWith("clean", [], { memoryTimeoutMs: 500 });
  });

  it("startNewSession() ends the current session quickly, reloads config, and creates a fresh one", async () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    await controller.start();

    const end = mock(async () => ({ memory: "background" as const }));
    const transcript = [{ kind: "user_message" as const }];
    controller.session = {
      ...controller.session,
      id: "sess-old",
      end,
      getTranscriptEvents: () => transcript,
    } as typeof controller.session;

    // Point configPath at a temp config file so startNewSession reloads from disk.
    const tmpConfigPath = join(tmpdir(), `praana-test-reload-${Date.now()}.json`);
    writeFileSync(tmpConfigPath, JSON.stringify({ llm: { model: "reloaded/model" } }), "utf-8");
    controller.parsed.configPath = tmpConfigPath;

    const create = Session.create as Mock<typeof Session.create>;
    create.mockResolvedValueOnce({
      id: "sess-new",
      cwd: "/tmp",
      debug: false,
      config: { ...baseConfig, llm: { provider: "openrouter", model: "reloaded/model" } },
      getModelOverride: () => null,
      getProviderOverride: () => null,
      setModelOverride: mock(),
      setProviderOverride: mock(),
      setIncognito: mock(async () => {}),
      getActiveModelId: () => "reloaded/model",
      getActiveModelLabel: () => "openrouter/reloaded/model",
      getEffectiveProvider: () => "openrouter",
      getContextWindowTokens: () => 128_000,
      refreshModelContextWindow: mock(async () => 128_000),
      getMemoryStats: () => ({
        total: 0,
        active: 0,
        soft: 0,
        hard: 0,
        byKind: {},
      }),
      getRepoRoot: () => "/tmp",
      getGitBranch: () => null,
      memoryEnabled: false,
      isIncognito: () => false,
      isPlanMode: () => false,
      digest: null,
      agentsContext: null,
      skills: [],
      skillRuntime: null,
      getLastCompileMetrics: () => null,
      getLastWeightedTokens: () => 0,
      getLastPressureMode: () => "normal" as const,
      getLastRawPressureRatio: () => 0,
      getDisplayContextSnapshot: () => null,
      isContextEngineEnabled: () => false,
      getStartedAt: () => Date.now(),
      getUptimeMs: () => 0,
      getTurnCount: () => 0,
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getPersistentMemoryEntryCount: () => 0,
      getMemoryDbPath: () => null,
      stateGraph: { list: () => [] },
      eventLog: { readLast: () => [] },
      end: mock(async () => ({ memory: "skipped" as const })),
      getTranscriptEvents: () => [],
    } as any);

    const info = await controller.startNewSession();

    expect(end).toHaveBeenCalledWith("clean", transcript, { memoryTimeoutMs: 50 });
    // Config was reloaded from the temp file.
    expect(controller.config.llm.model).toBe("reloaded/model");
    expect(controller.session.id).toBe("sess-new");
    expect(info.isResume).toBe(false);
    expect(info.bannerLines.some((line) => line.includes("sess-new"))).toBe(true);

    rmSync(tmpConfigPath, { force: true });
  });

  it("startNewSession() rolls back to a fresh session if Session.create throws", async () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    await controller.start();

    controller.session = {
      ...controller.session,
      id: "sess-old",
      end: mock(async () => ({ memory: "background" as const })),
      getTranscriptEvents: () => [],
    } as typeof controller.session;

    const create = Session.create as Mock<typeof Session.create>;
    // First call (inside startNewSession) throws; second call (rollback) succeeds.
    create
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(controller.session as any);

    await expect(controller.startNewSession()).rejects.toThrow("boom");
    // Rollback restored a session object so the controller is still usable.
    expect(controller.session).toBeDefined();
    expect(controller.sessionEnded).toBe(false);
  });

  it("shutdown() returns 'noop' on the second call", async () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    await controller.start();
    const end = controller.session.end as ReturnType<typeof mock>;
    end.mockResolvedValue({
      memory: "completed",
      turns: 0,
      stateObjects: 0,
      rememberCalls: 0,
      recallUsed: 0,
      learningsStored: 0,
    });

    const first = await controller.shutdown();
    expect(first.memory).toBe("completed");
    const second = await controller.shutdown();
    expect(second).toEqual({
      memory: "noop",
      turns: 0,
      stateObjects: 0,
      rememberCalls: 0,
      recallUsed: 0,
      learningsStored: 0,
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("handleUserInterrupt clears input when no turn is active and input has text", () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    expect(controller.handleUserInterrupt(false)).toBe("clear_input");
  });

  it("handleUserInterrupt exits when no turn is active and input is empty", () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    expect(controller.handleUserInterrupt(true)).toBe("exit");
  });

  it("handleUserInterrupt debounces repeated calls", () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    expect(controller.handleUserInterrupt(false)).toBe("clear_input");
    expect(controller.handleUserInterrupt(false)).toBe("noop");
  });

  it("handleUserInterrupt aborts an active turn", () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    (controller as any).turnController.begin();
    expect(controller.handleUserInterrupt(true)).toBe("abort_turn");
  });

  it("shutdown is a no-op when no session exists yet (startup window)", async () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    const status = await controller.shutdown();
    expect(status).toEqual({
      memory: "noop",
      turns: 0,
      stateObjects: 0,
      rememberCalls: 0,
      recallUsed: 0,
      learningsStored: 0,
    });
  });

  describe("runUserTurn interrupt handling", () => {
    const noopSink = {
      onTextDelta: () => {},
      onThinkingDelta: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onProviderUsage: () => {},
      onMemoryBanner: () => {},
      onSpinnerStart: () => {},
      onSpinnerStop: () => {},
      onNewline: () => {},
      onFallback: () => {},
      onSystemLines: () => {},
      onError: () => {},
      flushText: () => {},
      consumeTurnStats: () => null,
    } as never;

    it("swallows TurnAbortedError and returns to the caller (no crash)", async () => {
      const controller = new AppController({
        cwd: "/tmp",
        config: baseConfig,
        parsed: baseParsed,
      });

      // runTurn is mocked to throw TurnAbortedError (simulating an interrupted
      // turn whose partial response was already persisted).
      await expect(
        controller.runUserTurn("hello", noopSink),
      ).resolves.toBeUndefined();

      // Turn lifecycle must still be closed so a later turn can begin.
      expect(controller.isTurnActive()).toBe(false);
    });

    it("still propagates non-abort errors", async () => {
      (runTurn as unknown as Mock).mockImplementation(async () => {
        throw new Error("boom");
      });
      const controller = new AppController({
        cwd: "/tmp",
        config: baseConfig,
        parsed: baseParsed,
      });
      await expect(controller.runUserTurn("hello", noopSink)).rejects.toThrow(
        "boom",
      );
    });
  });

  it("resumes the latest session for cwd when resume has no session id", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "praana-test-app-controller-resume-"));
    const cwd = resolve("/tmp/praana-resume-test");
    const sessionId = "01LATEST00000000000000006";
    mkdirSync(join(logDir, sessionId), { recursive: true });
    writeFileSync(
      join(logDir, sessionId, "meta.json"),
      JSON.stringify(
        {
          session_id: sessionId,
          started_at: Date.now(),
          cwd,
          agent: "praana",
        },
        null,
        2,
      ) + "\n",
    );

    const resume = Session.resume as Mock<typeof Session.resume>;
    resume.mockResolvedValueOnce({
      id: sessionId,
      cwd,
      debug: false,
      config: baseConfig,
      getModelOverride: () => null,
      getProviderOverride: () => null,
      setModelOverride: mock(),
      setProviderOverride: mock(),
      setIncognito: mock(async () => {}),
      getActiveModelId: () => "test/model",
      getActiveModelLabel: () => "openrouter/test/model",
      getEffectiveProvider: () => "openrouter",
      getContextWindowTokens: () => 128_000,
      refreshModelContextWindow: mock(async () => 128_000),
      getMemoryStats: () => ({ total: 0, active: 0, soft: 0, hard: 0, byKind: {} }),
      getRepoRoot: () => cwd,
      getGitBranch: () => null,
      memoryEnabled: false,
      isIncognito: () => false,
      isPlanMode: () => false,
      digest: null,
      agentsContext: null,
      skills: [],
      skillRuntime: null,
      getLastCompileMetrics: () => null,
      getLastWeightedTokens: () => 0,
      getLastPressureMode: () => "normal" as const,
      getLastRawPressureRatio: () => 0,
      getDisplayContextSnapshot: () => null,
      isContextEngineEnabled: () => false,
      getStartedAt: () => Date.now(),
      getUptimeMs: () => 0,
      getTurnCount: () => 0,
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getPersistentMemoryEntryCount: () => 0,
      getMemoryDbPath: () => null,
      stateGraph: { list: () => [] },
      eventLog: {
        readLast: () => [],
        readAll: () => [],
        readAllAfterResetBoundary: () => [],
        readLastUncompressedAfterResetBoundary: () => [],
      },
      end: mock(async () => ({ memory: "skipped" as const })),
      getTranscriptEvents: () => [],
      memoryInitError: undefined,
    } as any);

    const controller = new AppController({
      cwd,
      config: { ...baseConfig, session: { log_dir: logDir } },
      parsed: { ...baseParsed, resumeMode: true, sessionId: null },
    });

    const info = await controller.start();
    expect(resume).toHaveBeenCalledWith(sessionId, cwd, expect.any(Object), expect.any(Object));
    expect(info.isResume).toBe(true);
    expect(info.session.id).toBe(sessionId);

    rmSync(logDir, { recursive: true, force: true });
  });

  it("starts a new session when bare resume finds no session for cwd", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "praana-test-app-controller-no-session-"));
    mkdirSync(logDir, { recursive: true });
    const cwd = resolve("/tmp/praana-no-session");

    const controller = new AppController({
      cwd,
      config: { ...baseConfig, session: { log_dir: logDir } },
      parsed: { ...baseParsed, resumeMode: true, sessionId: null },
    });

    const info = await controller.start();
    expect(info.isResume).toBe(false);
    expect(info.startupNotices).toEqual([
      `No session found for this directory: ${cwd}`,
      "Starting a new session.",
    ]);
    expect(info.session.id).toBeTruthy();

    rmSync(logDir, { recursive: true, force: true });
  });

  it("adds a startup notice when resuming with stale active tasks", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "praana-test-app-controller-stale-"));
    const cwd = resolve("/tmp/praana-stale-task");
    const sessionId = "01STALE00000000000000006";
    mkdirSync(join(logDir, sessionId), { recursive: true });
    writeFileSync(
      join(logDir, sessionId, "meta.json"),
      JSON.stringify(
        {
          session_id: sessionId,
          started_at: Date.now(),
          cwd,
          agent: "praana",
        },
        null,
        2,
      ) + "\n",
    );

    const staleTask = {
      id: "task-1",
      kind: "task" as const,
      tier: "active" as const,
      payload: { title: "Fix status bar crash", status: "todo" },
      created: Date.now(),
      updated: Date.now(),
      lastTouched: Date.now(),
    };

    const resume = Session.resume as Mock<typeof Session.resume>;
    resume.mockResolvedValueOnce({
      id: sessionId,
      cwd,
      debug: false,
      config: baseConfig,
      getModelOverride: () => null,
      getProviderOverride: () => null,
      setModelOverride: mock(),
      setProviderOverride: mock(),
      setIncognito: mock(async () => {}),
      getActiveModelId: () => "test/model",
      getActiveModelLabel: () => "openrouter/test/model",
      getEffectiveProvider: () => "openrouter",
      getContextWindowTokens: () => 128_000,
      refreshModelContextWindow: mock(async () => 128_000),
      getMemoryStats: () => ({ total: 0, active: 1, soft: 0, hard: 0, byKind: {} }),
      getRepoRoot: () => cwd,
      getGitBranch: () => null,
      memoryEnabled: false,
      isIncognito: () => false,
      digest: null,
      agentsContext: null,
      skills: [],
      skillRuntime: null,
      getLastCompileMetrics: () => null,
      getLastWeightedTokens: () => 0,
      getLastPressureMode: () => "normal" as const,
      getLastRawPressureRatio: () => 0,
      getDisplayContextSnapshot: () => null,
      isContextEngineEnabled: () => false,
      getStartedAt: () => Date.now(),
      getUptimeMs: () => 0,
      getTurnCount: () => 0,
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getPersistentMemoryEntryCount: () => 0,
      getMemoryDbPath: () => null,
      getStaleTasks: () => [staleTask],
      stateGraph: { list: () => [] },
      eventLog: {
        readLast: () => [],
        readAll: () => [],
        readAllAfterResetBoundary: () => [],
        readLastUncompressedAfterResetBoundary: () => [],
      },
      end: mock(async () => ({ memory: "skipped" as const })),
      getTranscriptEvents: () => [],
      memoryInitError: undefined,
    } as any);

    const controller = new AppController({
      cwd,
      config: { ...baseConfig, session: { log_dir: logDir } },
      parsed: { ...baseParsed, resumeMode: true, sessionId },
    });

    const info = await controller.start();
    expect(info.isResume).toBe(true);
    expect(info.startupNotices.some((n) => n.includes("stale active task"))).toBe(true);
    expect(info.startupNotices.some((n) => n.includes("Fix status bar crash"))).toBe(true);

    rmSync(logDir, { recursive: true, force: true });
  });

  it("applies persisted settings on start (thinking, debug) and creates settings.json", async () => {
    saveUserSettings({
      model: "",
      provider: "",
      thinking: false,
      incognito: false,
      debug: true,
      theme: "default",
    });

    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    await controller.start();

    expect(controller.showThinking).toBe(false);
    expect(controller.session.debug).toBe(true);
    expect(existsSync(getUserSettingsPath())).toBe(true);
  });

  it("CLI --incognito wins over settings.incognito", async () => {
    saveUserSettings({
      model: "",
      provider: "",
      thinking: true,
      incognito: true,
      debug: false,
      theme: "default",
    });

    const setIncognito = mock(async () => {});
    const create = Session.create as Mock<typeof Session.create>;
    create.mockResolvedValueOnce({
      id: "sess-1",
      cwd: "/tmp",
      debug: false,
      config: { llm: { provider: "openrouter", model: "test/model" } },
      getModelOverride: () => null,
      getProviderOverride: () => null,
      setModelOverride: mock(),
      setProviderOverride: mock(),
      setIncognito,
      getActiveModelId: () => "test/model",
      getActiveModelLabel: () => "openrouter/test/model",
      getEffectiveProvider: () => "openrouter",
      getContextWindowTokens: () => 128_000,
      refreshModelContextWindow: mock(async () => 128_000),
      getMemoryStats: () => ({ total: 0, active: 0, soft: 0, hard: 0, byKind: {} }),
      getRepoRoot: () => "/tmp",
      getGitBranch: () => null,
      memoryEnabled: false,
      isIncognito: () => true,
      isPlanMode: () => false,
      digest: null,
      agentsContext: null,
      skills: [],
      skillRuntime: null,
      getLastCompileMetrics: () => null,
      getLastWeightedTokens: () => 0,
      getLastPressureMode: () => "normal" as const,
      getLastRawPressureRatio: () => 0,
      getDisplayContextSnapshot: () => null,
      isContextEngineEnabled: () => false,
      getStartedAt: () => Date.now(),
      getUptimeMs: () => 0,
      getTurnCount: () => 0,
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getPersistentMemoryEntryCount: () => 0,
      getMemoryDbPath: () => null,
      stateGraph: { list: () => [] },
      eventLog: { readLast: () => [] },
      end: mock(async () => ({ memory: "skipped" as const })),
      getTranscriptEvents: () => [],
    } as any);

    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: { ...baseParsed, incognito: true },
    });
    await controller.start();

    expect(setIncognito).not.toHaveBeenCalled();
  });

  it("applies settings model/provider on new session when no override exists", async () => {
    saveUserSettings({
      model: "claude-sonnet",
      provider: "anthropic",
      thinking: true,
      incognito: false,
      debug: false,
      theme: "default",
    });

    let modelOverride: string | null = null;
    let providerOverride: string | null = null;
    const create = Session.create as Mock<typeof Session.create>;
    create.mockResolvedValueOnce({
      id: "sess-1",
      cwd: "/tmp",
      debug: false,
      config: { llm: { provider: "openrouter", model: "test/model" } },
      getModelOverride: () => modelOverride,
      getProviderOverride: () => providerOverride,
      setModelOverride: (m: string | null) => {
        modelOverride = m;
      },
      setProviderOverride: (p: string | null) => {
        providerOverride = p;
      },
      setIncognito: mock(async () => {}),
      getActiveModelId: () => modelOverride ?? "test/model",
      getActiveModelLabel: () =>
        `${providerOverride ?? "openrouter"}/${modelOverride ?? "test/model"}`,
      getEffectiveProvider: () => providerOverride ?? "openrouter",
      getContextWindowTokens: () => 128_000,
      refreshModelContextWindow: mock(async () => 128_000),
      getMemoryStats: () => ({ total: 0, active: 0, soft: 0, hard: 0, byKind: {} }),
      getRepoRoot: () => "/tmp",
      getGitBranch: () => null,
      memoryEnabled: false,
      isIncognito: () => false,
      isPlanMode: () => false,
      digest: null,
      agentsContext: null,
      skills: [],
      skillRuntime: null,
      getLastCompileMetrics: () => null,
      getLastWeightedTokens: () => 0,
      getLastPressureMode: () => "normal" as const,
      getLastRawPressureRatio: () => 0,
      getDisplayContextSnapshot: () => null,
      isContextEngineEnabled: () => false,
      getStartedAt: () => Date.now(),
      getUptimeMs: () => 0,
      getTurnCount: () => 0,
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getPersistentMemoryEntryCount: () => 0,
      getMemoryDbPath: () => null,
      stateGraph: { list: () => [] },
      eventLog: { readLast: () => [] },
      end: mock(async () => ({ memory: "skipped" as const })),
      getTranscriptEvents: () => [],
    } as any);

    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    await controller.start();

    expect(providerOverride).toBe("anthropic");
    expect(modelOverride).toBe("claude-sonnet");
    expect(controller.currentModel).toBe("claude-sonnet");
  });
});
// Restore real modules after this file to prevent cross-test pollution
afterAll(() => {
  mock.module("../src/session.js", () => sessionReal);
  mock.module("../src/turn.js", () => turnReal);
});
