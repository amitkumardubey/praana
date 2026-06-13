import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import type { PraanaConfig } from "../src/types.js";

const testLogDir = join(tmpdir(), "aria-test-session-skills-init");

function makeConfig(overrides: Partial<PraanaConfig> = {}): PraanaConfig {
  return {
    llm: { provider: "openrouter", model: "test/model" },
    memory: {
      enabled: false,
      summarizer: "disabled",
      db_path: join(tmpdir(), "aria-skills-init-memory.db"),
      embedder: "hash",
      ollama_url: "http://localhost:11434",
      ollama_model: "nomic-embed-text",
    },
    compiler: {
      token_budget: 100_000,
      recent_turns: 10,
      recent_turns_token_budget: 30_000,
    },
    tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
    session: { log_dir: testLogDir },
    ui: { mode: "readline", screen: "preserve" },
    skills: {
      enabled: true,
      max_token_budget_ratio: 0.2,
      active_skill_idle_turns: 5,
      warm_skill_eviction_turns: 20,
      max_depth: 6,
    },
    context_engine: {
      enabled: true,
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
    shell: { enabled: false, allowed_paths: [] },
    edit: { confirm: false },
    consolidation: {
      enabled: false,
      promotion_threshold: 3,
      run_delay_seconds: 30,
    },
    ...overrides,
  };
}

describe("Session skill initialization", () => {
  afterEach(() => {
    rmSync(testLogDir, { recursive: true, force: true });
  });

  it("initializes SkillRuntime when context engine is enabled", async () => {
    const session = await Session.create(process.cwd(), makeConfig());
    expect(session.contextEngine).not.toBeNull();
    expect(session.skillRuntime).not.toBeNull();
    await session.end("clean");
  });

  it("uses classic skill catalog when context engine is disabled", async () => {
    const config = makeConfig({
      context_engine: {
        ...makeConfig().context_engine,
        enabled: false,
      },
    });
    const session = await Session.create(process.cwd(), config);
    expect(session.contextEngine).toBeNull();
    expect(session.skillRuntime).toBeNull();
    await session.end("clean");
  });
});
