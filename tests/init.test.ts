import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { handleInit } from "../src/init.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("praana init", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `praana-test-${Date.now()}`);
    const { mkdirSync } = require("node:fs");
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    const { rmSync } = require("node:fs");
    rmSync(testDir, { recursive: true, force: true });
  });

  function configPath(): string {
    return join(testDir, ".praana", "config.toml");
  }

  it("should create the global config file in ~/.praana/", async () => {
    const result = await handleInit({ force: false, homeDir: testDir });
    expect(result.success).toBe(true);
    expect(result.action).toBe("created");
    expect(existsSync(configPath())).toBe(true);
  });

  it("should refuse to overwrite existing config without --force", async () => {
    // Create initial config
    await handleInit({ force: false, homeDir: testDir });

    // Try to create again without --force
    const result = await handleInit({ force: false, homeDir: testDir });
    expect(result.success).toBe(false);
    expect(result.action).toBe("skipped");
  });

  it("should overwrite existing config with --force", async () => {
    // Create initial config
    await handleInit({ force: false, homeDir: testDir });

    // Overwrite with --force
    const result = await handleInit({ force: true, homeDir: testDir });
    expect(result.success).toBe(true);
    expect(result.action).toBe("overwritten");
  });

  it("should create a commented template even when an env key is present", async () => {
    // Env keys must not silently pre-fill [llm] — guided setup owns that choice.
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.UMANS_AI_CODING_PLAN_API_KEY;

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const result = await handleInit({ force: false, homeDir: testDir });

    expect(result.success).toBe(true);
    const content = readFileSync(configPath(), "utf-8");
    expect(content).not.toContain('provider = "anthropic"');
    expect(content).toContain("# provider = \"openrouter\"");
    expect(content).toContain("# Uncomment and set your provider and model");

    delete process.env.ANTHROPIC_API_KEY;
  });

  it("should create a commented template when no env keys are set", async () => {
    const originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.UMANS_AI_CODING_PLAN_API_KEY;

    const result = await handleInit({ force: false, homeDir: testDir });

    expect(result.success).toBe(true);
    const content = readFileSync(configPath(), "utf-8");
    expect(content).not.toContain('provider = "ollama"');
    expect(content).toContain("# Uncomment and set your provider and model");

    process.env = originalEnv;
  });

});
