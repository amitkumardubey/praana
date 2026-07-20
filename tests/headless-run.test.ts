import { describe, it, expect, mock } from "bun:test";
import {
  createHeadlessTurnSink,
  validateRunPrompt,
  withMaxSteps,
  runHeadless,
} from "../src/headless-run.js";
import type { PraanaConfig } from "../src/types.js";

function baseConfig(): PraanaConfig {
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
    session: { log_dir: "/tmp/praana-headless-test" },
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
    turn: { max_steps: 25 },
  };
}

describe("validateRunPrompt", () => {
  it("rejects empty / whitespace prompts", () => {
    expect(() => validateRunPrompt(null)).toThrow(/Usage: praana run/);
    expect(() => validateRunPrompt("")).toThrow(/Usage: praana run/);
    expect(() => validateRunPrompt("   ")).toThrow(/Usage: praana run/);
  });

  it("returns trimmed prompt", () => {
    expect(validateRunPrompt("  fix tests  ")).toBe("fix tests");
  });
});

describe("withMaxSteps", () => {
  it("leaves config unchanged when maxSteps is null/undefined", () => {
    const cfg = baseConfig();
    expect(withMaxSteps(cfg, null)).toBe(cfg);
    expect(withMaxSteps(cfg, undefined).turn.max_steps).toBe(25);
  });

  it("returns a copy with overridden turn.max_steps", () => {
    const cfg = baseConfig();
    const next = withMaxSteps(cfg, 40);
    expect(next.turn.max_steps).toBe(40);
    expect(cfg.turn.max_steps).toBe(25);
    expect(next).not.toBe(cfg);
  });
});

describe("createHeadlessTurnSink", () => {
  it("writes text deltas to stdout writer and system lines to stderr", () => {
    const out: string[] = [];
    const err: string[] = [];
    const sink = createHeadlessTurnSink({
      writeStdout: (c) => out.push(c),
      writeStderr: (c) => err.push(c),
    });
    sink.onTextDelta?.("hello");
    sink.onSystemLines?.(["step limit"]);
    expect(out).toEqual(["hello"]);
    expect(err).toEqual(["step limit\n"]);
  });
});

describe("runHeadless", () => {
  it("creates a session, runs one turn, and shuts down", async () => {
    const end = mock(async () => ({
      memory: "skipped" as const,
      turns: 1,
      stateObjects: 0,
      rememberCalls: 0,
      recallUsed: 0,
      learningsStored: 0,
    }));
    const session = {
      id: "01HEADLESSSESSION",
      debug: false,
      end,
      getTranscriptEvents: () => [],
    };
    const createSession = mock(async (_cwd: string, config: PraanaConfig) => {
      expect(config.turn.max_steps).toBe(12);
      return session as never;
    });
    const runTurnFn = mock(async (_s: unknown, prompt: string) => {
      expect(prompt).toBe("do the thing");
      return "done";
    });

    const result = await runHeadless({
      cwd: "/tmp",
      config: baseConfig(),
      prompt: "do the thing",
      maxSteps: 12,
      createSession,
      runTurnFn: runTurnFn as never,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(runTurnFn).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("01HEADLESSSESSION");
    expect(result.response).toBe("done");
  });

  it("ends session with error reason when turn fails", async () => {
    const end = mock(async () => ({
      memory: "skipped" as const,
      turns: 0,
      stateObjects: 0,
      rememberCalls: 0,
      recallUsed: 0,
      learningsStored: 0,
    }));
    const session = {
      id: "01FAIL",
      debug: false,
      end,
      getTranscriptEvents: () => [],
    };
    await expect(
      runHeadless({
        cwd: "/tmp",
        config: baseConfig(),
        prompt: "boom",
        createSession: async () => session as never,
        runTurnFn: async () => {
          throw new Error("provider down");
        },
      }),
    ).rejects.toThrow("provider down");
    expect(end).toHaveBeenCalledWith(
      "error",
      [],
      expect.objectContaining({ memoryTimeoutMs: 50 }),
    );
  });
});
