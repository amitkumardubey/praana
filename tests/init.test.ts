import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

  it("should create a config file in the specified directory", () => {
    const result = handleInit({ force: false, cwd: testDir });
    expect(result.success).toBe(true);
    expect(result.action).toBe("created");
    expect(existsSync(join(testDir, "praana.config.toml"))).toBe(true);
  });

  it("should refuse to overwrite existing config without --force", () => {
    // Create initial config
    handleInit({ force: false, cwd: testDir });
    
    // Try to create again without --force
    const result = handleInit({ force: false, cwd: testDir });
    expect(result.success).toBe(false);
    expect(result.action).toBe("skipped");
  });

  it("should overwrite existing config with --force", () => {
    // Create initial config
    handleInit({ force: false, cwd: testDir });
    
    // Overwrite with --force
    const result = handleInit({ force: true, cwd: testDir });
    expect(result.success).toBe(true);
    expect(result.action).toBe("overwritten");
  });

  it("should create a config with provider info when env key is detected", () => {
    // Clear all provider keys first
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
    
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const result = handleInit({ force: false, cwd: testDir });
    
    expect(result.success).toBe(true);
    const content = readFileSync(join(testDir, "praana.config.toml"), "utf-8");
    expect(content).toContain('provider = "anthropic"');
    expect(content).toContain('model = "claude-sonnet-4-20250514"');
    
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("should create config with ollama when no env keys are set (keyless provider)", () => {
    // Ensure no provider keys are set (ollama is always available as keyless)
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
    
    const result = handleInit({ force: false, cwd: testDir });
    
    expect(result.success).toBe(true);
    const content = readFileSync(join(testDir, "praana.config.toml"), "utf-8");
    // ollama is always detected as a keyless provider
    expect(content).toContain('provider = "ollama"');
    expect(content).toContain('model = "llama3"');
    
    // Restore environment
    process.env = originalEnv;
  });
});
