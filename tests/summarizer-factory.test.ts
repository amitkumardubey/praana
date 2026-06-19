import { describe, it, expect } from "vitest";
import { createSummarizer } from "../src/memory/summarizer-factory.js";
import { pickDefaultChatModel } from "../src/memory/ollama-summarizer.js";
import type { MemoryConfig } from "../src/types.js";

function makeConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    enabled: true,
    summarizer: "disabled",
    embedder: "auto",
    ollama_url: "http://localhost:11434",
    ollama_model: "nomic-embed-text",
    ...overrides,
  };
}

describe("pickDefaultChatModel", () => {
  it("skips embedding models and returns first chat model", () => {
    expect(
      pickDefaultChatModel([
        "nomic-embed-text:latest",
        "qwen3.5:4b",
        "gemma4:latest",
      ]),
    ).toBe("qwen3.5:4b");
  });

  it("returns null when only embedding models exist", () => {
    expect(pickDefaultChatModel(["nomic-embed-text:latest", "qwen3-embedding:4b"])).toBeNull();
  });
});

describe("createSummarizer factory", () => {
  it("returns null when summarizer is disabled", async () => {
    const s = await createSummarizer(makeConfig({ summarizer: "disabled" }));
    expect(s).toBeNull();
  });

  it("returns null when ollama is unreachable", async () => {
    const s = await createSummarizer(
      makeConfig({
        summarizer: "ollama",
        ollama_url: "http://127.0.0.1:19999",
        ollama_summarizer_model: "qwen3.5:4b",
      }),
    );
    expect(s).toBeNull();
  });

  it("returns null for openrouter without API key", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    const prevOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const s = await createSummarizer(makeConfig({ summarizer: "openrouter" }));
      expect(s).toBeNull();
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
      if (prevOpenAi !== undefined) process.env.OPENAI_API_KEY = prevOpenAi;
    }
  });
});
