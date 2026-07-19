import { getModel, getModels, getEnvApiKey, getProviders, findEnvKeys, clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import type { PraanaConfig, UserProviderConfig, UserProviderModel } from "./types.js";
import { mapProviderToPiAi, resolveContextWindowSync, isInPiAiCatalog, normalizeModelIdForProvider } from "./model-context.js";
import { getAppLogger } from "./logger.js";
import {
  PROVIDER_REGISTRY,
  REASONING_MODEL_HINTS,
  getProviderEnvKey,
  getUserProviderRegistryEntry,
  isUserDeclaredProvider,
  getUserProviderConfig,
  listUserDeclaredProviderIds,
  type ProviderConfig,
} from "./provider-registry.js";
import { resolveApiKey, hasApiKey } from "./credentials.js";

export {
  resolveContextWindowSync,
  fetchAndCacheContextWindow,
  DEFAULT_MODEL_CONTEXT_WINDOW,
} from "./model-context.js";

export { getProviderEnvKey } from "./provider-registry.js";
export {
  getUserProviderConfig,
  isUserDeclaredProvider,
  setUserProviders,
} from "./provider-registry.js";
export type { ProviderConfig } from "./provider-registry.js";
export { resolveApiKey, hasApiKey, getApiKey, setApiKey } from "./credentials.js";

// ── Provider auto-detection ───────────────────────────────────

/**
 * Precedence order for auto-detecting a provider from environment keys.
 * First provider whose env var is set wins.
 */
const DETECTION_PRECEDENCE: string[] = [
  "anthropic",
  "openai",
  "deepseek",
  "groq",
  "google",
  "mistral",
  "xai",
  "fireworks",
  "together",
  "opencode",
  "umans",
  "openrouter",
  "amazon-bedrock",  // AWS credentials (envKey: null, special check in isProviderAvailable)
  "ollama",          // local, no key (PRAANA-specific, not in pi-ai)
];
export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-20250514",
  openai: "gpt-4o",
  deepseek: "deepseek-chat",
  groq: "llama-3.1-70b-versatile",
  google: "gemini-2.0-flash",
  mistral: "mistral-large-latest",
  xai: "grok-2",
  fireworks: "accounts/fireworks/models/llama-v3p1-70b-instruct",
  together: "meta-llama/Llama-3.1-70B-Instruct-Turbo",
  opencode: "gpt-4o",
  openrouter: "deepseek/deepseek-v4-flash:free",
  ollama: "llama3",
  umans: "umans-coder",
  "amazon-bedrock": "anthropic.claude-sonnet-4-20250514-v1:0",
};

export function pickFirstCatalogModel(provider: string): string | undefined {
  const piProvider = mapProviderToPiAi(provider) ?? provider;
  if (!(getProviders() as string[]).includes(piProvider)) return undefined;
  const models = getModels(piProvider as never);
  return models?.[0]?.id;
}

/**
 * Auto-detect the first available provider from environment variables.
 * Returns `{ provider, model }` or `null` if nothing is found.
 */
export function detectProviderFromEnvironment(): { provider: string; model: string } | null {
  const logger = getAppLogger().child("llm");

  // Phase 1: curated precedence (PRAANA-specific ordering + keyless providers)
  for (const provider of DETECTION_PRECEDENCE) {
    if (isProviderAvailable(provider)) {
      const model = DEFAULT_MODELS[provider] ?? pickFirstCatalogModel(provider) ?? "";
      logger.info(`Auto-detected provider "${provider}" from environment`, {
        details: { provider, model },
      });
      return { provider, model };
    }
  }

  // Phase 2: remaining pi-ai providers not already checked
  const checked = new Set(DETECTION_PRECEDENCE);
  for (const provider of (getProviders() as string[])) {
    if (checked.has(provider)) continue;
    if (isProviderAvailable(provider)) {
      const model = DEFAULT_MODELS[provider] ?? pickFirstCatalogModel(provider) ?? "";
      logger.info(`Auto-detected provider "${provider}" from environment`, {
        details: { provider, model },
      });
      return { provider, model };
    }
  }

  logger.debug("No provider API key found in environment");
  return null;
}

/** Return all available providers, curated precedence first, then remaining pi-ai providers. */
export function listAvailableProviders(): string[] {
  const all = listKnownProviders();
  const precedence = new Set(DETECTION_PRECEDENCE);
  const ordered: string[] = DETECTION_PRECEDENCE.filter(isProviderAvailable);
  for (const provider of all) {
    if (!precedence.has(provider) && isProviderAvailable(provider)) {
      ordered.push(provider);
    }
  }
  return ordered;
}

// ── Exported helpers ───────────────────────────────────────────

/**
 * Lookup a provider config. User-declared providers (from config.toml
 * `[providers.<id>]`) take precedence over the hardcoded registry.
 * Falls back to openrouter for unknown values.
 */
export function getProviderConfig(provider: string): ProviderConfig {
  // 1. User-declared provider (from config.toml [providers.<id>]).
  const userEntry = getUserProviderRegistryEntry(provider);
  if (userEntry) return userEntry;

  // 2. Hardcoded registry.
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry) {
    getAppLogger().child("llm").warn(
      `Unknown provider "${provider}", falling back to openrouter. Known providers: ${listKnownProviders().join(", ")}`,
    );
    return PROVIDER_REGISTRY["openrouter"];
  }
  return entry;
}

/** Return all known provider IDs (union of user-declared, registry, and pi-ai). */
export function listKnownProviders(): string[] {
  const registryIds = Object.keys(PROVIDER_REGISTRY);
  const piAiIds = getProviders() as string[];
  const userIds = listUserDeclaredProviderIds();
  return Array.from(new Set([...registryIds, ...piAiIds, ...userIds])).sort();
}

/**
 * Check whether the provider's API key is available.
 *
 * Resolution order:
 *   1. Credential store (~/.praana/credentials.json)
 *   2. Environment variable (registry envKey or user-declared env_key)
 *   3. Keyless providers (e.g. ollama) → always available
 *
 * User-declared providers with no env_key and no stored key are
 * considered available if they have no env_key declared (keyless
 * local servers like Ollama/vLLM without auth).
 */
export function isProviderAvailable(provider: string): boolean {
  // Special-case AWS Bedrock: needs actual AWS credentials.
  if (provider === "amazon-bedrock") {
    return !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_SESSION_TOKEN);
  }

  // 1. Credential store — checked for all providers.
  if (hasApiKey(provider)) return true;

  // 2. User-declared providers.
  if (isUserDeclaredProvider(provider)) {
    const userConfig = getUserProviderConfig(provider);
    if (!userConfig) return false;
    // Keyless user-declared provider (no env_key) → available.
    if (!userConfig.env_key) return true;
    // Check env var fallback.
    return !!process.env[userConfig.env_key];
  }

  // 3. Registry providers.
  const registryEntry = PROVIDER_REGISTRY[provider];

  // Providers explicitly marked keyless in the registry (ollama).
  if (registryEntry && registryEntry.envKey === null) return true;

  // Registry entry with an env key — check if that env var is set.
  if (registryEntry?.envKey) {
    return !!process.env[registryEntry.envKey];
  }

  // 4. For providers known to pi-ai but NOT in our registry, use pi-ai's
  //    key detection.
  const piProviders = getProviders() as string[];
  if (piProviders.includes(provider)) {
    return !!getEnvApiKey(provider as never);
  }

  // Unknown provider.
  return false;
}

/** Human-readable message explaining which env var is missing. */
export function getMissingKeyMessage(provider: string): string | null {
  if (isProviderAvailable(provider)) return null;

  const envKey = getProviderEnvKey(provider);
  if (envKey && PROVIDER_REGISTRY[provider]) {
    return `Missing required env var: ${envKey}`;
  }

  const piKeys = findEnvKeys(provider as never);
  if (piKeys?.length) {
    return `Missing required env var: ${piKeys.join(" or ")}`;
  }

  return `Provider "${provider}" is not configured`;
}

/** Whether a model likely requires chain-of-thought enabled on the wire. */
export function inferReasoningModel(provider: string, modelId: string): boolean {
  // Check configurable hints first (provider-specific, then global "*").
  const providerHints = REASONING_MODEL_HINTS[provider];
  const globalHints = REASONING_MODEL_HINTS["*"];
  for (const hints of [providerHints, globalHints]) {
    if (hints?.some((h) => h.pattern.test(modelId))) return true;
  }
  // Fall back to pi-ai catalog metadata.
  if (isInPiAiCatalog(provider, modelId)) {
    const piProvider = mapProviderToPiAi(provider) ?? provider;
    const catalogModel = getModel(piProvider as never, modelId as never);
    return !!catalogModel?.reasoning;
  }
  return false;
}

type RuntimeModel = Record<string, unknown> & {
  __piOptions?: Record<string, unknown>;
};

function buildFromPiAiCatalog(
  config: PraanaConfig["llm"],
  modelId: string,
  contextWindow?: number,
): RuntimeModel | null {
  const piProvider = mapProviderToPiAi(config.provider) ?? config.provider;
  if (!(getProviders() as string[]).includes(piProvider)) return null;

  const catalogModel = getModel(piProvider as never, modelId as never);
  if (!catalogModel) return null;

  const model: RuntimeModel = {
    ...catalogModel,
    contextWindow:
      contextWindow ??
      resolveContextWindowSync(config.provider, modelId, config.context_window),
  };

  // Key resolution: credential store > env var > empty.
  // For pi-ai catalog providers, resolveApiKey checks the credential
  // store first, then the provider's env key.
  const pc = getProviderConfig(config.provider);
  const apiKey = resolveApiKey(config.provider, pc.envKey);

  model.__piOptions = {
    apiKey,
    headers: catalogModel.headers ? { ...catalogModel.headers } : undefined,
  };

  return model;
}

function buildModel(
  config: PraanaConfig["llm"],
  modelId: string,
  contextWindow?: number,
): RuntimeModel {
  const normalizedId = normalizeModelIdForProvider(config.provider, modelId);
  const fromCatalog = buildFromPiAiCatalog(config, normalizedId, contextWindow);
  if (fromCatalog) return fromCatalog;

  const pc = getProviderConfig(config.provider);

  const baseUrl = config.base_url ?? pc.baseUrl;
  // Key resolution: credential store > env_key > "no-key" sentinel.
  const apiKey = resolveApiKey(config.provider, pc.envKey);

  // Check for user-declared model metadata overrides.
  const userModel = getUserDeclaredModel(config.provider, normalizedId);

  const model: RuntimeModel = {
    id: normalizedId,
    name: normalizedId,
    provider: pc.provider,
    api: userModel?.api ?? pc.api,
    baseUrl,
    input: ["text"],
    reasoning: userModel?.reasoning ?? inferReasoningModel(config.provider, normalizedId),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow:
      userModel?.context_window ??
      contextWindow ??
      resolveContextWindowSync(config.provider, normalizedId, config.context_window),
    maxTokens: userModel?.max_tokens ?? 8192,
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

/**
 * Look up a user-declared model metadata override for a provider + model id.
 * Returns undefined if the provider is not user-declared or the model id
 * has no declared metadata.
 */
function getUserDeclaredModel(
  provider: string,
  modelId: string,
): UserProviderModel | undefined {
  const userConfig = getUserProviderConfig(provider);
  if (!userConfig?.models) return undefined;
  return userConfig.models.find((m) => m.id === modelId);
}

export function createProvider(config: PraanaConfig["llm"], contextWindow?: number) {
  return (modelId: string) => buildModel(config, modelId, contextWindow);
}

export function resolveModel(modelString: string) {
  return modelString;
}

// ── Reasoning / thinking-level helpers ────────────────────────

const DEFAULT_REASONING_LEVEL = "medium";

/**
 * Determine the `reasoningEffort` value to pass to pi-ai `stream()`.
 *
 * Returns `undefined` when the model does not need chain-of-thought,
 * or a clamped reasoning level string (e.g. "medium") when it does.
 */
export function getReasoningEffort(
  model: Record<string, unknown>,
  modelId: string,
  provider: string,
): string | undefined {
  const needsReasoning =
    !!model.reasoning || inferReasoningModel(provider, modelId);
  if (!needsReasoning) return undefined;

  // Only call clampThinkingLevel if model has the pi-ai catalog shape
  // with thinkingLevelMap. Manually built models may lack this.
  const thinkingLevelMap = model.thinkingLevelMap as
    | Record<string, string | null>
    | undefined;
  if (thinkingLevelMap) {
    try {
      return clampThinkingLevel(
        { thinkingLevelMap } as Parameters<typeof clampThinkingLevel>[0],
        DEFAULT_REASONING_LEVEL,
      );
    } catch {
      getAppLogger().child("llm").warn(
        "clampThinkingLevel failed, using default reasoning",
      );
    }
  }
  return DEFAULT_REASONING_LEVEL;
}
