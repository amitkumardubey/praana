import { createOpenAI } from "@ai-sdk/openai";
import type { AriaConfig } from "./types.js";

export function createProvider(config: AriaConfig["llm"]) {
  // Ollama - OpenAI-compatible local API
  if (config.provider === "ollama") {
    return createOpenAI({
      apiKey: "ollama", // Ollama doesn't need a real key
      baseURL: config.base_url ?? "http://127.0.0.1:11434/v1",
    });
  }

  const apiKey =
    config.provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY
      : process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.warn(
      `[llm] No API key found for provider "${config.provider}". Set OPENROUTER_API_KEY or other provider key.`
    );
  }

  // OpenRouter uses OpenAI-compatible API
  if (config.provider === "openrouter") {
    return createOpenAI({
      apiKey,
      baseURL: config.base_url ?? "https://openrouter.ai/api/v1",
      headers: {
        "HTTP-Referer": "https://github.com/aria",
        "X-Title": "ARIA",
      },
    });
  }

  // Direct OpenAI
  if (config.provider === "openai") {
    return createOpenAI({
      apiKey,
      baseURL: config.base_url,
    });
  }

  // Default: OpenRouter-compatible
  return createOpenAI({
    apiKey,
    baseURL: config.base_url ?? "https://openrouter.ai/api/v1",
    headers: {
      "HTTP-Referer": "https://github.com/aria",
      "X-Title": "ARIA",
    },
  });
}

export function resolveModel(modelString: string) {
  // Model format: "provider/model-name" for OpenRouter
  // Direct provider: just the model name
  return modelString;
}
