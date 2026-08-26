// ============================================================
// PRAANA Memory — Summarizer factory
// Powered by the native LLM engine
// ============================================================

import type { MemoryConfig } from "../types.js";
import type { SummarizerLLM } from "./types.js";
import { getAppLogger } from "../logger.js";
import { envOverride } from "../app-identity.js";
import { completeLlmResponse, isProviderAuthenticated } from "../llm/index.js";
import { OllamaEmbedder } from "./embeddings.js";

const SUMMARIZER_MODELS: Record<string, string> = {
  anthropic: "claude-3-5-haiku-20241022",
  openai: "gpt-4o-mini",
  google: "gemini-2.0-flash",
  openrouter: "anthropic/claude-3-5-haiku",
  deepseek: "deepseek-chat",
  groq: "llama-3.3-70b-versatile",
  azure: "gpt-4o-mini",
  ollama: "llama3",
  "amazon-bedrock": "anthropic.claude-3-5-haiku-20241022-v1:0",
};

export function summarizerModelForProvider(provider: string): string {
  return SUMMARIZER_MODELS[provider] || DEFAULT_FALLBACK_MODEL[provider] || "gpt-4o-mini";
}

const DEFAULT_FALLBACK_MODEL: Record<string, string> = {
  xai: "grok-2",
  fireworks: "accounts/fireworks/models/llama-v3p1-70b-instruct",
  together: "meta-llama/Llama-3.1-70B-Instruct-Turbo",
  opencode: "gpt-4o-mini",
  umans: "umans-coder",
  poolside: "poolside/laguna-s-2.1",
  mistral: "mistral-small-latest",
};

class NativeSummarizer implements SummarizerLLM {
  name: string;

  constructor(
    private provider: string,
    private model: string,
  ) {
    this.name = `${provider}/${model}`;
  }

  async available(): Promise<boolean> {
    return isProviderAuthenticated(this.provider);
  }

  async complete(opts: {
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
    timeoutMs?: number;
  }): Promise<string> {
    const result = await completeLlmResponse({
      provider: this.provider,
      model: this.model,
      systemPrompt: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
      temperature: opts.temperature ?? 0.2,
      maxTokens: opts.maxTokens,
    });
    return result.fullResponse || "";
  }
}

export async function createSummarizer(
  config: MemoryConfig,
): Promise<SummarizerLLM | null> {
  const log = getAppLogger().child("memory");
  const mode = (config.summarizer ?? "auto").toLowerCase();
  if (mode === "disabled") return null;

  const overrideModel = envOverride("PRAANA_SUMMARIZER_MODEL")?.trim();

  // If a specific provider is configured (e.g. "anthropic", "openai", "openrouter", "google", "ollama")
  if (mode !== "auto") {
    if (mode === "ollama") {
      const url = config.ollama_url ?? "http://localhost:11434";
      const model = config.ollama_summarizer_model || overrideModel || "llama3";
      if (!(await OllamaEmbedder.isAvailable(url, model))) {
        log.warn(`Ollama model '${model}' is not available at ${url}`);
        return null;
      }
      return new NativeSummarizer("ollama", model);
    }

    if (isProviderAuthenticated(mode)) {
      const model = overrideModel || summarizerModelForProvider(mode);
      return new NativeSummarizer(mode, model);
    }
    return null;
  }

  // Auto mode: check available authenticated providers
  const preferredProviders = [
    "anthropic",
    "openai",
    "google",
    "openrouter",
    "deepseek",
    "groq",
  ];
  for (const provider of preferredProviders) {
    if (isProviderAuthenticated(provider)) {
      const model = overrideModel || summarizerModelForProvider(provider);
      return new NativeSummarizer(provider, model);
    }
  }

  log.debug("No authenticated provider available for session summarization");
  return null;
}
