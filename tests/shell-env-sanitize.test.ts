import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeShellCommand } from "../src/tools/system.js";
import {
  collectSensitiveEnvKeys,
  sanitizeChildEnv,
} from "../src/tools/sanitize-child-env.js";

describe("sanitizeChildEnv", () => {
  it("strips known LLM provider keys", () => {
    const keys = collectSensitiveEnvKeys();
    expect(keys).toContain("OPENROUTER_API_KEY");
    expect(keys).toContain("ANTHROPIC_API_KEY");
    expect(keys).toContain("OPENAI_API_KEY");
    expect(keys).toContain("AWS_SECRET_ACCESS_KEY");
    expect(keys).not.toContain("AWS_PROFILE");
    expect(keys).not.toContain("AWS_REGION");
    expect(keys).not.toContain("GH_TOKEN");
  });

  it("removes keys from a copied env while keeping PATH", () => {
    const sanitized = sanitizeChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/test",
      OPENROUTER_API_KEY: "sk-or-secret",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      AWS_PROFILE: "dev",
    });
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.HOME).toBe("/home/test");
    expect(sanitized.AWS_PROFILE).toBe("dev");
    expect(sanitized.OPENROUTER_API_KEY).toBeUndefined();
    expect(sanitized.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe("executeShellCommand env sanitization", () => {
  let tmp: string;
  let previous: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "praana-shell-env-"));
    previous = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-must-not-leak";
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("does not inherit OPENROUTER_API_KEY in the child", async () => {
    const result = await executeShellCommand({
      command: "printf '%s' \"$OPENROUTER_API_KEY\"",
      cwd: tmp,
    });
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("");
  });
});
