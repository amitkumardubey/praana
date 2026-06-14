/**
 * Single source of truth for provider configuration.
 *
 * Both `llm.ts` (model building) and `provider-catalog.ts` (live catalog
 * fetching) need the same base URLs, env keys, and headers. Keeping them
 * in one file prevents the two copies from drifting apart.
 */

export interface ProviderConfig {
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

export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  // ── OpenAI-compatible (use "openai-completions" API) ──
  openrouter: {
    api: "openai-completions",
    provider: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    headers: {
      "HTTP-Referer": "https://github.com/amitkumardubey/praana",
      "X-Title": "PRAANA",
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
  opencode: {
    api: "openai-completions",
    provider: "opencode",
    envKey: "OPENCODE_API_KEY",
    baseUrl: "https://opencode.ai/zen/v1",
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

/**
 * Vendors whose models can be reached via a different vendor prefix on
 * certain providers.  When a bare model name (no `/`) is provided, the
 * resolver generates additional candidate IDs using these aliases.
 *
 * Structure: `provider → Array<{ pattern, vendor }>`
 *   - `pattern` is tested against the bare model name (case-insensitive)
 *   - `vendor` is the prefix prepended to the model name
 *
 * Example: on OpenRouter, `kimi-k2.5` → `moonshotai/kimi-k2.5`
 */
export const VENDOR_PREFIX_ALIASES: Record<
  string,
  Array<{ pattern: RegExp; vendor: string }>
> = {
  openrouter: [{ pattern: /^kimi-/i, vendor: "moonshotai" }],
};

/**
 * Model name patterns that are known to require chain-of-thought
 * (reasoning) even if the pi-ai catalog does not flag them.
 *
 * Structure: `provider → Array<{ pattern }>`
 *   - `pattern` is tested against the full model id (case-insensitive)
 *
 * The `"*"` key applies to all providers. Add provider-specific entries
 * to override or extend the global patterns for a single provider.
 * Note: `"*"` patterns match before provider-specific ones, so a model
 * name that happens to match a global pattern on a provider that doesn't
 * need reasoning will be incorrectly flagged. Add provider-specific
 * overrides when this becomes an issue.
 */
export const REASONING_MODEL_HINTS: Record<
  string,
  Array<{ pattern: RegExp }>
> = {
  "*": [{ pattern: /kimi-k2/i }],
};

/**
 * Providers that expose an OpenAI-compatible `/models` listing endpoint.
 * Used by `provider-catalog.ts` for live catalog fetching.
 *
 * Base URLs, env keys, and headers are looked up from `PROVIDER_REGISTRY`
 * at fetch time — no duplication needed here.
 */
export const LIVE_CATALOG_PROVIDER_IDS: string[] = [
  "openrouter",
  "openai",
  "deepseek",
  "groq",
  "xai",
  "fireworks",
  "opencode",
  "together",
  "ollama",
];
