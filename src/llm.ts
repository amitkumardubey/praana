import type { AriaConfig } from "./types.js";

// ── Provider registry ──────────────────────────────────────────
// Each entry maps a config `provider` string to pi-ai's model fields.
// Add new providers here — no other code changes needed.

interface ProviderConfig {
  /** pi-ai API type identifier */
  api: string;
  /** pi-ai provider identifier */
  provider: string;
  /** Env var to check for API key, or null if none needed */
  envKey: string | null;
  /** Default base URL for this provider's API */
  baseUrl: string;
  /** Optional HTTP headers sent with every request */
  headers?: Record<string, string>;
}

const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  // ── OpenAI-compatible (use "openai-completions" API) ──
  openrouter: {
    api: "openai-completions",
    provider: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    headers: {
      "HTTP-Referer": "https://github.com/aria",
      "X-Title": "ARIA",
    },
  },
  openai: {
    api: "openai-completions",
    provider: "openai",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
  },
  deepseek: {
    api: "openai-completions",
    provider: "deepseek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
  },
  groq: {
    api: "openai-completions",
    provider: "groq",
    envKey: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  xai: {
    api: "openai-completions",
    provider: "xai",
    envKey: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
  },
  fireworks: {
    api: "openai-completions",
    provider: "fireworks",
    envKey: "FIREWORKS_API_KEY",
    baseUrl: "https://api.fireworks.ai/inference/v1",
  },
  together: {
    api: "openai-completions",
    provider: "together",
    envKey: "TOGETHER_API_KEY",
    baseUrl: "https://api.together.xyz/v1",
  },
  ollama: {
    api: "openai-completions",
    provider: "openai",
    envKey: null, // local — no key needed
    baseUrl: "http://127.0.0.1:11434/v1",
  },
  opencode: {
    api: "openai-completions",
    provider: "opencode",
    envKey: "OPENCODE_API_KEY",
    baseUrl: "https://opencode.ai/zen/v1",
  },

  // ── Native API (different wire protocol) ──
  anthropic: {
    api: "anthropic-messages",
    provider: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com",
  },
  google: {
    api: "google-generative-ai",
    provider: "google",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
  mistral: {
    api: "mistral-conversations",
    provider: "mistral",
    envKey: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
  },
  "amazon-bedrock": {
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    envKey: null, // uses AWS credentials (env / IAM / profile)
    baseUrl: "",
  },
};

// ── Exported helpers ───────────────────────────────────────────

/** Lookup a provider config. Falls back to openrouter for unknown values. */
export function getProviderConfig(provider: string): ProviderConfig {
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry) {
    console.warn(
      `[llm] Unknown provider "${provider}", falling back to openrouter. ` +
        `Known providers: ${listKnownProviders().join(", ")}`
    );
    return PROVIDER_REGISTRY["openrouter"];
  }
  return entry;
}

/** Return all known provider IDs (for docs / help text). */
export function listKnownProviders(): string[] {
  return Object.keys(PROVIDER_REGISTRY).sort();
}

/** Return the env var name required by a provider, or null. */
export function getProviderEnvKey(provider: string): string | null {
  return getProviderConfig(provider).envKey;
}

/** Check whether the provider's API key is available in the environment. */
export function isProviderAvailable(provider: string): boolean {
  const envKey = getProviderEnvKey(provider);
  if (envKey === null) return true; // no key needed (ollama, bedrock)
  return !!process.env[envKey];
}

/** Human-readable message explaining which env var is missing. */
export function getMissingKeyMessage(provider: string): string | null {
  const envKey = getProviderEnvKey(provider);
  if (envKey === null) return null;
  if (process.env[envKey]) return null;
  return `Missing required environment variable: ${envKey}`;
}

// ── Model construction ─────────────────────────────────────────

type RuntimeModel = Record<string, unknown> & {
  __piOptions?: Record<string, unknown>;
};

function buildModel(config: AriaConfig["llm"], modelId: string): RuntimeModel {
  const pc = getProviderConfig(config.provider);

  const baseUrl = config.base_url ?? pc.baseUrl;
  const apiKey = pc.envKey ? (process.env[pc.envKey] ?? "") : "no-key";

  const model: RuntimeModel = {
    id: modelId,
    name: modelId,
    provider: pc.provider,
    api: pc.api,
    baseUrl,
    input: ["text"],
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };

  if (pc.headers) {
    model.headers = { ...pc.headers };
  }

  model.__piOptions = {
    apiKey,
    headers: pc.headers ? { ...pc.headers } : undefined,
  };

  return model;
}

export function createProvider(config: AriaConfig["llm"]) {
  return (modelId: string) => buildModel(config, modelId);
}

export function resolveModel(modelString: string) {
  return modelString;
}
