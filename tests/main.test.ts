import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

  function runMain(configPath: string) {
    return spawnSync(
      process.execPath,
      ["src/main.ts", "--config", configPath],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: root,
          PRAANA_HOME: root,
          VITEST: "true",
          NODE_ENV: "test",
        },
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
});
