import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import type { PraanaConfig } from "../src/types.js";

const testLogDir = join(tmpdir(), "praana-test-session-project-context");

function makeConfig(overrides: Partial<PraanaConfig> = {}): PraanaConfig {
  return {
    llm: { provider: "openrouter", model: "test/model" },
    memory: {
      enabled: false,
      summarizer: "disabled",
      db_path: join(tmpdir(), "praana-project-context-memory.db"),
      embedder: "auto",
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
    skills: { enabled: false, max_token_budget_ratio: 0.2, max_loaded_skills: 3, stale_threshold_turns: 10, max_depth: 6 },
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
    shell: { enabled: false, allowed_paths: [] },
    edit: { confirm: false },
    consolidation: {
      enabled: false,
      promotion_threshold: 3,
      run_delay_seconds: 30,
    },
    project_detection: { enabled: true },
    ...overrides,
  };
}

describe("Session project context", () => {
  let projectDir: string;

  afterEach(() => {
    rmSync(testLogDir, { recursive: true, force: true });
    if (projectDir) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("stores projectContext on session but not in StateGraph when engine is disabled", async () => {
    projectDir = join(tmpdir(), `praana-project-classic-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "classic-demo", scripts: { test: "vitest" } }),
      "utf-8",
    );

    const session = await Session.create(projectDir, makeConfig());
    expect(session.projectContext).toContain("Project: classic-demo");
    expect(
      session.stateGraph
        .list()
        .some((o) => o.kind === "constraint" && String((o.payload as { text?: string }).text).includes("classic-demo")),
    ).toBe(false);

    await session.end("clean");
  });

  it("stores projectContext in StateGraph when context engine is enabled", async () => {
    projectDir = join(tmpdir(), `praana-project-engine-${Date.now()}`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "engine-demo", scripts: { build: "tsc" } }),
      "utf-8",
    );

    const session = await Session.create(
      projectDir,
      makeConfig({
        context_engine: {
          ...makeConfig().context_engine,
          enabled: true,
        },
      }),
    );

    expect(session.projectContext).toContain("Project: engine-demo");
    expect(session.contextEngine).not.toBeNull();
    expect(
      session.stateGraph
        .getActive()
        .some(
          (o) =>
            o.kind === "constraint" &&
            String((o.payload as { text?: string }).text).startsWith("Project:"),
        ),
    ).toBe(true);

    await session.end("clean");
  });
});
