import type { UserProviderConfig } from "./types.js";

/**
 * Single source of truth for provider configuration.
 *
 * Both `llm.ts` (model building) and `provider-catalog.ts` (live catalog
 * fetching) need the same base URLs, env keys, and headers. Keeping them
 * in one file prevents the two copies from drifting apart.
 */

/**
 * pi-ai openai-completions compat overrides.
 * Used to avoid sending OpenAI-only fields that break OpenAI-compatible gateways.
 */
export interface ProviderWireCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  thinkingFormat?: string;
  chatTemplateKwargs?: Record<string, unknown>;
}

export interface ProviderConfig {
  /** pi-ai API type identifier */
  api: string;
  /** pi-ai provider identifier */
  provider: string;
  /** Env var to check for API key, or null if none needed */
  envKey: string | null;
  /** Additional env vars accepted as aliases for the primary envKey */
  envKeyAliases?: string[];
  /** Default base URL for this provider's API */
  baseUrl: string;
  /** Optional HTTP headers sent with every request */
  headers?: Record<string, string>;
  /** Wire-protocol compat overrides for openai-completions / similar */
  compat?: ProviderWireCompat;
}

// ── User-declared providers (module-level, set at config load) ──

/**
 * User-declared providers from config.toml `[providers.<id>]` sections.
 * Set once at config load time via `setUserProviders()`. Checked BEFORE
 * the hardcoded PROVIDER_REGISTRY so user declarations take precedence.
 */
let _userProviders: Record<string, UserProviderConfig> = {};

/**
 * Inject user-declared providers from parsed config. Called once at
 * `loadConfig()` time. Passing undefined clears the set.
 */
export function setUserProviders(
  providers: Record<string, UserProviderConfig> | undefined,
): void {
  _userProviders = providers ?? {};
}

/** Returns true if a provider id is user-declared (in config.toml). */
export function isUserDeclaredProvider(provider: string): boolean {
  return provider in _userProviders;
}

/**
 * Get a user-declared provider config, or undefined if not declared.
 */
export function getUserProviderConfig(
  provider: string,
): UserProviderConfig | undefined {
  return _userProviders[provider];
}

/**
 * Get the env key for a user-declared provider (from config env_key field).
 */
export function getUserProviderEnvKey(provider: string): string | null {
  const userConfig = _userProviders[provider];
  return userConfig?.env_key ?? null;
}

/** List all user-declared provider ids. */
export function listUserDeclaredProviderIds(): string[] {
  return Object.keys(_userProviders);
}

/**
 * Convert a user-declared provider config into the ProviderConfig shape
 * used by llm.ts and provider-catalog.ts. Returns undefined if the
 * provider is not user-declared.
 */
export function getUserProviderRegistryEntry(
  provider: string,
): ProviderConfig | undefined {
  const userConfig = _userProviders[provider];
  if (!userConfig) return undefined;
  return {
    api: userConfig.api,
    provider,
    envKey: userConfig.env_key ?? null,
    baseUrl: userConfig.base_url,
    headers: userConfig.headers,
  };
}

/** Test helper — clear user-declared providers (for isolated tests). */
export function resetUserProvidersForTests(): void {
  _userProviders = {};
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
  umans: {
    api: "openai-completions",
    provider: "umans",
    // Docs use UMANS_API_KEY; keep the older models.dev name as an alias.
    envKey: "UMANS_API_KEY",
    envKeyAliases: ["UMANS_AI_CODING_PLAN_API_KEY"],
    baseUrl: "https://api.code.umans.ai/v1",
    // Avoid OpenAI-only fields that many gateways reject.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    },
  },
  // Poolside Platform — OpenAI-compatible; paste API key from platform.poolside.ai
  // (enterprise browser OAuth is a separate follow-up).
  poolside: {
    api: "openai-completions",
    provider: "poolside",
    envKey: "POOLSIDE_API_KEY",
    baseUrl: "https://inference.poolside.ai/v1",
    // Platform rejects OpenAI-only fields (store / stream_options / developer role)
    // with HTTP 400. Thinking uses chat_template_kwargs per Poolside docs.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "qwen-chat-template",
    },
  },
  nvidia: {
    api: "openai-completions",
    provider: "nvidia",
    envKey: "NVIDIA_API_KEY",
    baseUrl: "https://integrate.api.nvidia.com/v1",
  },
  cerebras: {
    api: "openai-completions",
    provider: "cerebras",
    envKey: "CEREBRAS_API_KEY",
    baseUrl: "https://api.cerebras.ai/v1",
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
    envKeyAliases: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
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

  // ── Subscription OAuth (pi-ai/oauth) ──
  // envKey null + not keyless: availability requires stored OAuth (or Copilot env token).
  "openai-codex": {
    api: "openai-codex-responses",
    provider: "openai-codex",
    envKey: null,
    baseUrl: "https://chatgpt.com/backend-api",
  },
  "github-copilot": {
    api: "anthropic-messages", // catalog mixes APIs; wire protocol comes from model entries
    provider: "github-copilot",
    envKey: "COPILOT_GITHUB_TOKEN",
    baseUrl: "https://api.individual.githubcopilot.com",
    headers: {
      "Editor-Version": "Praana/0.12.0",
      "Editor-Plugin-Version": "praana/0.12.0",
      "Copilot-Integration-Id": "vscode-chat",
    },
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
  umans: [
    { pattern: /umans-coder/i },
    { pattern: /umans-kimi/i },
    { pattern: /umans-glm/i },
    { pattern: /kimi-k2/i },
    { pattern: /glm-/i },
  ],
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
  "umans",
  "poolside",
  "cerebras",
  "amazon-bedrock",
];

/**
 * pi-ai API ids that use the OpenAI-compatible wire protocol and thus
 * expose a `/v1/models` listing endpoint. User-declared providers using
 * one of these APIs get live catalog support automatically.
 */
export const OPENAI_COMPATIBLE_API_IDS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
]);

/** Providers that should not appear in the interactive setup picker. */
export const SETUP_UNSUPPORTED_PROVIDERS = new Set(["ollama"]);

/** All env var names accepted for a provider (primary + aliases). */
export function getProviderEnvKeys(provider: string): string[] {
  const userEnvKey = getUserProviderEnvKey(provider);
  if (userEnvKey) return [userEnvKey];
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry?.envKey) return [];
  return [entry.envKey, ...(entry.envKeyAliases ?? [])];
}

/** Return the env var name required by a provider, or null. */
export function getProviderEnvKey(provider: string): string | null {
  // User-declared providers take precedence.
  const userEnvKey = getUserProviderEnvKey(provider);
  if (userEnvKey !== null) return userEnvKey;

  const registryEntry = PROVIDER_REGISTRY[provider];
  if (registryEntry) return registryEntry.envKey;
  return null;
}

/** Format all known providers for display in help/init text. */
export function formatProviderListForDisplay(): { name: string; envKey: string | null }[] {
  const registryIds = Object.keys(PROVIDER_REGISTRY);
  const userIds = listUserDeclaredProviderIds();
  const all = Array.from(new Set([...registryIds, ...userIds])).sort();
  return all.map((name) => ({ name, envKey: getProviderEnvKey(name) }));
}