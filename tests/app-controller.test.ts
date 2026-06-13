import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppController } from "../src/app-controller.js";
import type { CliArgs } from "../src/cli-args.js";
import type { PraanaConfig } from "../src/types.js";

vi.mock("../src/session.js", () => ({
  Session: {
    create: vi.fn(async () => ({
      id: "sess-1",
      cwd: "/tmp",
      debug: false,
      config: { llm: { model: "test/model" } },
      getModelOverride: () => null,
      getContextWindowTokens: () => 128_000,
      refreshModelContextWindow: vi.fn(async () => 128_000),
      getMemoryStats: () => ({
        total: 0,
        active: 0,
        soft: 0,
        hard: 0,
        byKind: {},
      }),
      getRepoRoot: () => "/tmp",
      memoryEnabled: false,
      isIncognito: () => false,
      digest: null,
      agentsContext: null,
      skills: [],
      skillRuntime: null,
      getLastCompileMetrics: () => null,
      getStartedAt: () => Date.now(),
      getUptimeMs: () => 0,
      getTurnCount: () => 0,
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getPersistentMemoryEntryCount: () => 0,
      getMemoryDbPath: () => null,
      stateGraph: { list: () => [] },
      eventLog: { readLast: () => [] },
      end: vi.fn(),
      getTranscriptEvents: () => [],
    })),
    resume: vi.fn(),
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
  ui: { mode: "tui", screen: "preserve" },
};

const baseParsed: CliArgs = {
  sessionId: null,
  resumeMode: false,
  debug: false,
  incognito: false,
  configPath: undefined,
  showHelp: false,
  uiMode: undefined,
  screenMode: undefined,
};

describe("AppController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(status.model).toBe("test/model");
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
});
