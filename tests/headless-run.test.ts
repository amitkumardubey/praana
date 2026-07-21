import { describe, it, expect, mock, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHeadlessTurnSink,
  validateRunPrompt,
  withMaxSteps,
  runHeadless,
  estimateCostUsd,
  buildHeadlessUsageReport,
  writeHeadlessUsageReport,
} from "../src/headless-run.js";
import type { PraanaConfig } from "../src/types.js";

function baseConfig(): PraanaConfig {
  return {
    llm: { provider: "openrouter", model: "anthropic/claude-sonnet-5" },
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

describe("estimateCostUsd", () => {
  it("estimates cost for known models", () => {
    // 1M in + 1M out at $3 / $15 → $18
    expect(estimateCostUsd("anthropic/claude-sonnet-5", 1_000_000, 1_000_000)).toBe(18);
  });

  it("returns null for unknown models", () => {
    expect(estimateCostUsd("totally-unknown-model-xyz", 1000, 100)).toBeNull();
  });

  it("estimates cost for umans-coder (kimi rates)", () => {
    // 1M in + 1M out at $0.95 / $4 → $4.95
    expect(estimateCostUsd("umans-coder", 1_000_000, 1_000_000)).toBe(4.95);
    expect(estimateCostUsd("umans/umans-coder", 1_000_000, 1_000_000)).toBe(4.95);
  });

  it("estimates cost for umans glm / kimi / flash / qwen ids", () => {
    expect(estimateCostUsd("umans-glm-5.2", 1_000_000, 1_000_000)).toBe(5.8);
    expect(estimateCostUsd("umans/umans-glm-5.2", 1_000_000, 1_000_000)).toBe(5.8);
    expect(estimateCostUsd("umans-glm-5.1", 1_000_000, 1_000_000)).toBe(5.8);
    expect(estimateCostUsd("umans-kimi-k2.7", 1_000_000, 1_000_000)).toBe(4.95);
    expect(estimateCostUsd("umans/umans-kimi-k2.7", 1_000_000, 1_000_000)).toBe(4.95);
    // flash / qwen: $0.15 / $1.00 → $1.15
    expect(estimateCostUsd("umans-flash", 1_000_000, 1_000_000)).toBe(1.15);
    expect(estimateCostUsd("umans-qwen3.6-35b-a3b", 1_000_000, 1_000_000)).toBe(1.15);
  });
});

describe("usage report", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("buildHeadlessUsageReport reads session token counters", () => {
    const cfg = baseConfig();
    const report = buildHeadlessUsageReport({
      id: "01USAGE",
      config: cfg,
      getInputTokens: () => 1200,
      getOutputTokens: () => 340,
      getEffectiveReasoningEffort: () => "high",
      getLastReasoningEffortUsed: () => "high",
    });
    expect(report.n_input_tokens).toBe(1200);
    expect(report.n_output_tokens).toBe(340);
    expect(report.model).toBe("anthropic/claude-sonnet-5");
    expect(report.reasoning_effort).toBe("high");
    expect(report.reasoning_effort_wire).toBe("high");
    expect(report.cost_usd).not.toBeNull();
  });

  it("writeHeadlessUsageReport writes JSON to disk", () => {
    dir = mkdtempSync(join(tmpdir(), "praana-usage-"));
    const path = join(dir, "praana-usage.json");
    const cfg = baseConfig();
    writeHeadlessUsageReport(
      {
        id: "01WRITE",
        config: cfg,
        getInputTokens: () => 10,
        getOutputTokens: () => 5,
        getEffectiveReasoningEffort: () => "medium",
        getLastReasoningEffortUsed: () => null,
      },
      path,
    );
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.schema_version).toBe(1);
    expect(parsed.n_input_tokens).toBe(10);
    expect(parsed.n_output_tokens).toBe(5);
    expect(parsed.reasoning_effort).toBe("medium");
    expect(parsed.reasoning_effort_wire).toBeNull();
  });
});

describe("runHeadless", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("creates a session, runs one turn, and shuts down", async () => {
    dir = mkdtempSync(join(tmpdir(), "praana-headless-"));
    const usagePath = join(dir, "usage.json");
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
      config: baseConfig(),
      end,
      getTranscriptEvents: () => [],
      getInputTokens: () => 100,
      getOutputTokens: () => 20,
      getEffectiveReasoningEffort: () => "medium",
      getLastReasoningEffortUsed: () => "medium",
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
      usagePath,
      createSession,
      runTurnFn: runTurnFn as never,
    });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(runTurnFn).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("01HEADLESSSESSION");
    expect(result.response).toBe("done");
    expect(result.usage?.n_input_tokens).toBe(100);
    expect(JSON.parse(readFileSync(usagePath, "utf8")).n_output_tokens).toBe(20);
  });

  it("ends session with error reason when turn fails", async () => {
    dir = mkdtempSync(join(tmpdir(), "praana-headless-err-"));
    const usagePath = join(dir, "usage.json");
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
      config: baseConfig(),
      end,
      getTranscriptEvents: () => [],
      getInputTokens: () => 0,
      getOutputTokens: () => 0,
      getEffectiveReasoningEffort: () => "medium",
      getLastReasoningEffortUsed: () => null,
    };
    await expect(
      runHeadless({
        cwd: "/tmp",
        config: baseConfig(),
        prompt: "boom",
        usagePath,
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
    expect(readFileSync(usagePath, "utf8")).toContain("n_input_tokens");
  });
});
