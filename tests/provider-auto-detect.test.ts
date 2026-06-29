import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  detectProviderFromEnvironment,
  listAvailableProviders,
  isProviderAvailable,
} from "../src/llm.js";

describe("Provider auto-detection", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all provider-related env vars
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.FIREWORKS_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    delete process.env.OPENCODE_API_KEY;
  });

  afterEach(() => {
    // Restore original env
    process.env = { ...originalEnv };
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
