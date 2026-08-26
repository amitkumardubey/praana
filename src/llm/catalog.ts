// ============================================================
// PRAANA — Model Catalog & Metadata
// ============================================================

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow: number;
  description?: string;
  reasoning?: boolean;
}

export const CURATED_MODELS: Record<string, ModelCatalogEntry[]> = {
  anthropic: [
    {
      id: "claude-sonnet-4-6",
      name: "Claude 3.7 Sonnet (Hybrid Thinking)",
      provider: "anthropic",
      contextWindow: 200_000,
      reasoning: true,
    },
    {
      id: "claude-3-5-sonnet-20241022",
      name: "Claude 3.5 Sonnet",
      provider: "anthropic",
      contextWindow: 200_000,
    },
    {
      id: "claude-3-5-haiku-20241022",
      name: "Claude 3.5 Haiku",
      provider: "anthropic",
      contextWindow: 200_000,
    },
    {
      id: "claude-3-opus-20240229",
      name: "Claude 3 Opus",
      provider: "anthropic",
      contextWindow: 200_000,
    },
  ],
  openai: [
    {
      id: "gpt-4o",
      name: "GPT-4o (Omni)",
      provider: "openai",
      contextWindow: 128_000,
    },
    {
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      provider: "openai",
      contextWindow: 128_000,
    },
    {
      id: "o1",
      name: "o1 (High Reasoning)",
      provider: "openai",
      contextWindow: 200_000,
      reasoning: true,
    },
    {
      id: "o3-mini",
      name: "o3-mini (Fast Reasoning)",
      provider: "openai",
      contextWindow: 200_000,
      reasoning: true,
    },
  ],
  deepseek: [
    {
      id: "deepseek-chat",
      name: "DeepSeek V3",
      provider: "deepseek",
      contextWindow: 64_000,
    },
    {
      id: "deepseek-reasoner",
      name: "DeepSeek R1 (Reasoning)",
      provider: "deepseek",
      contextWindow: 64_000,
      reasoning: true,
    },
  ],
  google: [
    {
      id: "gemini-2.0-flash",
      name: "Gemini 2.0 Flash",
      provider: "google",
      contextWindow: 1_048_576,
    },
    {
      id: "gemini-2.0-pro-exp-02-05",
      name: "Gemini 2.0 Pro Experimental",
      provider: "google",
      contextWindow: 2_097_152,
    },
    {
      id: "gemini-2.0-flash-thinking-exp-01-21",
      name: "Gemini 2.0 Flash Thinking",
      provider: "google",
      contextWindow: 1_048_576,
      reasoning: true,
    },
  ],
  groq: [
    {
      id: "llama-3.3-70b-versatile",
      name: "Llama 3.3 70B (Groq LPU)",
      provider: "groq",
      contextWindow: 128_000,
    },
    {
      id: "deepseek-r1-distill-llama-70b",
      name: "DeepSeek R1 Distill 70B",
      provider: "groq",
      contextWindow: 128_000,
      reasoning: true,
    },
  ],
  openrouter: [
    {
      id: "anthropic/claude-sonnet-4-6",
      name: "Claude 3.7 Sonnet (via OpenRouter)",
      provider: "openrouter",
      contextWindow: 200_000,
      reasoning: true,
    },
    {
      id: "deepseek/deepseek-r1",
      name: "DeepSeek R1 (via OpenRouter)",
      provider: "openrouter",
      contextWindow: 64_000,
      reasoning: true,
    },
    {
      id: "openai/gpt-4o",
      name: "GPT-4o (via OpenRouter)",
      provider: "openrouter",
      contextWindow: 128_000,
    },
  ],
  azure: [
    {
      id: "gpt-4o",
      name: "Azure OpenAI GPT-4o",
      provider: "azure",
      contextWindow: 128_000,
    },
  ],
  "amazon-bedrock": [
    {
      id: "anthropic.claude-sonnet-4-20250514-v1:0",
      name: "Claude 3.7 Sonnet (Bedrock)",
      provider: "amazon-bedrock",
      contextWindow: 200_000,
    },
    {
      id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      name: "Claude 3.5 Sonnet v2 (Bedrock)",
      provider: "amazon-bedrock",
      contextWindow: 200_000,
    },
  ],
  ollama: [
    {
      id: "llama3.3",
      name: "Llama 3.3 (Local)",
      provider: "ollama",
      contextWindow: 128_000,
    },
    {
      id: "deepseek-r1",
      name: "DeepSeek R1 (Local)",
      provider: "ollama",
      contextWindow: 64_000,
      reasoning: true,
    },
    {
      id: "qwen2.5-coder",
      name: "Qwen 2.5 Coder (Local)",
      provider: "ollama",
      contextWindow: 32_768,
    },
  ],
};

/**
 * Get curated models for a provider.
 */
export function getCuratedModels(provider: string): ModelCatalogEntry[] {
  return CURATED_MODELS[provider] || [];
}

/**
 * Get a model entry by ID and provider.
 */
export function getModelCatalogEntry(provider: string, modelId: string): ModelCatalogEntry | undefined {
  const models = getCuratedModels(provider);
  return models.find((m) => m.id === modelId || m.id.endsWith(`/${modelId}`));
}
