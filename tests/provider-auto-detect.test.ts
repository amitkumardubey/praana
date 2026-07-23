import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectProviderFromEnvironment,
  listAvailableProviders,
  isProviderAvailable,
} from "../src/llm.js";
import { resetCredentialStoreForTests } from "../src/credentials.js";

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
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
] as const;

describe("Provider auto-detection", () => {
  let praanaHome: string;
  let prevHome: string | undefined;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    praanaHome = mkdtempSync(join(tmpdir(), "praana-auto-detect-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = praanaHome;
    resetCredentialStoreForTests();

    for (const key of PROVIDER_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    rmSync(praanaHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;

    for (const key of PROVIDER_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe("detectProviderFromEnvironment", () => {
    it("should return ollama when no provider keys are set (keyless provider)", () => {
      const result = detectProviderFromEnvironment();
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("ollama");
    });

    it("should detect ANTHROPIC_API_KEY and return anthropic provider", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const result = detectProviderFromEnvironment();
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("anthropic");
      expect(result!.model).toBe("claude-sonnet-4-20250514");
    });

    it("should detect OPENAI_API_KEY and return openai provider", () => {
      process.env.OPENAI_API_KEY = "sk-test";
      const result = detectProviderFromEnvironment();
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("openai");
      expect(result!.model).toBe("gpt-4o");
    });

    it("should detect DEEPSEEK_API_KEY and return deepseek provider", () => {
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
      const result = detectProviderFromEnvironment();
      expect(result).not.toBeNull();
      expect(result!.provider).toBe("deepseek");
      expect(result!.model).toBe("deepseek-chat");
    });

    it("should follow precedence order: anthropic > openai > deepseek", () => {
      process.env.OPENAI_API_KEY = "sk-test";
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      const result = detectProviderFromEnvironment();
      expect(result!.provider).toBe("anthropic");
    });

    it("should detect multiple keys and return first in precedence", () => {
      process.env.GROQ_API_KEY = "gsk-test";
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      const result = detectProviderFromEnvironment();
      expect(result!.provider).toBe("groq");
    });
  });

  describe("listAvailableProviders", () => {
    it("should return ollama when no keys are set (keyless provider)", () => {
      const result = listAvailableProviders();
      expect(result).toContain("ollama");
    });

    it("should return providers in detection precedence order", () => {
      process.env.OPENAI_API_KEY = "sk-test";
      process.env.DEEPSEEK_API_KEY = "sk-deepseek-test";
      const result = listAvailableProviders();
      expect(result).toContain("openai");
      expect(result).toContain("deepseek");
      expect(result.indexOf("openai")).toBeLessThan(result.indexOf("deepseek"));
    });
  });

  describe("isProviderAvailable", () => {
    it("should return false for provider with no key", () => {
      expect(isProviderAvailable("anthropic")).toBe(false);
    });

    it("should return true for provider with key", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      expect(isProviderAvailable("anthropic")).toBe(true);
    });

    it("should return true for ollama (keyless)", () => {
      expect(isProviderAvailable("ollama")).toBe(true);
    });
  });
});
