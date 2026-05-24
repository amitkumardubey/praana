import type { AriaConfig } from "./types.js";

type RuntimeModel = Record<string, unknown> & {
  __piOptions?: Record<string, unknown>;
};

function resolveApiKey(config: AriaConfig["llm"]): string {
  if (config.provider === "ollama") return "ollama";

  const apiKey =
    config.provider === "openrouter"
      ? process.env.OPENROUTER_API_KEY
      : process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    const envVar =
      config.provider === "openrouter"
        ? "OPENROUTER_API_KEY"
        : "OPENAI_API_KEY or ANTHROPIC_API_KEY";
    throw new Error(
      `[llm] No API key found for provider "${config.provider}". ` +
      `Please set ${envVar} environment variable or configure a local API key.`
    );
  }

  return apiKey;
}

function buildModel(config: AriaConfig["llm"], modelId: string): RuntimeModel {
  const isOpenRouter = config.provider === "openrouter";
  const isOllama = config.provider === "ollama";
  const isOpenAI = config.provider === "openai";

  const baseUrl = isOllama
    ? config.base_url ?? "http://127.0.0.1:11434/v1"
    : isOpenRouter
      ? config.base_url ?? "https://openrouter.ai/api/v1"
      : config.base_url ?? "https://api.openai.com/v1";

  const model: RuntimeModel = {
    id: modelId,
    name: modelId,
    provider: isOpenRouter ? "openrouter" : "openai",
    api: "openai-completions",
    baseUrl,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };

  if (isOpenRouter && !isOpenAI) {
    model.headers = {
      "HTTP-Referer": "https://github.com/aria",
      "X-Title": "ARIA",
    };
  }

  model.__piOptions = {
    apiKey: resolveApiKey(config),
    headers:
      isOpenRouter && !isOpenAI
        ? {
            "HTTP-Referer": "https://github.com/aria",
            "X-Title": "ARIA",
          }
        : undefined,
  };

  return model;
}

export function createProvider(config: AriaConfig["llm"]) {
  return (modelId: string) => buildModel(config, modelId);
}

export function resolveModel(modelString: string) {
  // Model format: "provider/model-name" for OpenRouter
  // Direct provider: just the model name
  return modelString;
}
