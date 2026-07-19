import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROVIDER_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "OPENCODE_API_KEY",
  "UMANS_AI_CODING_PLAN_API_KEY",
  "NVIDIA_API_KEY",
] as const;

describe("main entrypoint guards", () => {
  let root: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "praana-main-test-"));
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    rmSync(root, { recursive: true, force: true });
  });

  function baseEnv(extra: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: root,
      PRAANA_HOME: root,
      VITEST: "true",
      NODE_ENV: "test",
      ...extra,
    };
    for (const key of PROVIDER_ENV_KEYS) {
      if (!(key in extra)) delete env[key];
    }
    return env;
  }

  function runMain(configPath: string) {
    return spawnSync(
      process.execPath,
      ["src/main.ts", "--config", configPath],
      {
        cwd: process.cwd(),
        env: baseEnv(),
        input: "",
      },
    );
  }

  it("exits with an interactive-terminal error when stdin is not a TTY", () => {
    const configPath = join(root, "config.toml");
    writeFileSync(
      configPath,
      '[llm]\nprovider = "ollama"\nmodel = "llama3"\n',
      "utf-8",
    );

    const result = runMain(configPath);
    const stderr = result.stderr.toString("utf-8");

    expect(result.status).toBe(1);
    expect(stderr).toContain("interactive terminal");
  });

  it("exits cleanly when a model is not configured", () => {
    const configPath = join(root, "config.toml");
    writeFileSync(
      configPath,
      '[llm]\nprovider = "ollama"\nmodel = ""\n',
      "utf-8",
    );

    const result = runMain(configPath);
    const stderr = result.stderr.toString("utf-8");

    expect(result.status).toBe(1);
    expect(stderr).toContain("No model is configured");
    expect(stderr).not.toContain("interactive terminal");
  });

  it("auto-selects a single env provider and skips the no-key exit path", () => {
    // No config file — true first run. Exactly one key-requiring provider available.
    const result = spawnSync(process.execPath, ["src/main.ts"], {
      cwd: process.cwd(),
      env: baseEnv({ OPENROUTER_API_KEY: "sk-or-test-auto" }),
      input: "",
    });

    const stdout = result.stdout.toString("utf-8");
    const stderr = result.stderr.toString("utf-8");

    expect(stdout).toContain("Adopted OPENROUTER_API_KEY");
    expect(stderr).not.toContain("no API key found");
    expect(stderr).not.toContain("PRAANA needs a model provider");

    const writtenConfig = join(root, ".praana", "config.toml");
    expect(existsSync(writtenConfig)).toBe(true);
    expect(readFileSync(writtenConfig, "utf-8")).toContain('provider = "openrouter"');

    const creds = join(root, ".praana", "credentials.json");
    expect(existsSync(creds)).toBe(true);
    expect(readFileSync(creds, "utf-8")).toContain("sk-or-test-auto");

    // Still non-TTY, so session start fails later — but not on the missing-key path.
    expect(result.status).toBe(1);
    expect(stderr).toContain("interactive terminal");
  });
});
