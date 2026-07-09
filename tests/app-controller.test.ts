import { describe, it, expect, beforeEach, afterAll, mock, type Mock } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AppController } from "../src/app-controller.js";
import type { CliArgs } from "../src/cli-args.js";
import type { PraanaConfig } from "../src/types.js";
import * as sessionActual from "../src/session.js";
import { Session } from "../src/session.js";

// Snapshot real module BEFORE mock.module updates live bindings
const sessionReal = { ...sessionActual };

mock.module("../src/session.js", () => ({
  Session: {
    create: mock(async () => ({
      id: "sess-1",
      cwd: "/tmp",
      debug: false,
      config: { llm: { provider: "openrouter", model: "test/model" } },
      getModelOverride: () => null,
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
  beforeEach(() => {
    mock.clearAllMocks();
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
    end.mockResolvedValueOnce({ memory: "background" });

    const status = await controller.shutdown();
    expect(status).toEqual({ memory: "background" });
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
    end.mockResolvedValueOnce({ memory: "completed" });

    const status = await controller.shutdown();
    expect(status).toEqual({ memory: "completed" });
    expect(end).toHaveBeenCalledWith("clean", [], { memoryTimeoutMs: 500 });
  });

  it("shutdown() returns 'noop' on the second call", async () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    await controller.start();
    const end = controller.session.end as ReturnType<typeof mock>;
    end.mockResolvedValue({ memory: "completed" });

    expect(await controller.shutdown()).toEqual({ memory: "completed" });
    expect(await controller.shutdown()).toEqual({ memory: "noop" });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("handleUserInterrupt clears input when no turn is active", () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    expect(controller.handleUserInterrupt()).toBe("clear_input");
  });

  it("handleUserInterrupt debounces repeated calls", () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    expect(controller.handleUserInterrupt()).toBe("clear_input");
    expect(controller.handleUserInterrupt()).toBe("noop");
  });

  it("handleUserInterrupt aborts an active turn", () => {
    const controller = new AppController({
      cwd: "/tmp",
      config: baseConfig,
      parsed: baseParsed,
    });
    (controller as any).turnController.begin();
    expect(controller.handleUserInterrupt()).toBe("abort_turn");
  });

  it("resumes the latest session for cwd when resume has no session id", async () => {
    const logDir = join(tmpdir(), "praana-test-app-controller-resume");
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
      eventLog: { readLast: () => [], readAll: () => [] },
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
    const logDir = join(tmpdir(), "praana-test-app-controller-no-session");
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
});
// Restore real session module after this file to prevent cross-test pollution
afterAll(() => {
  mock.module("../src/session.js", () => sessionReal);
});
