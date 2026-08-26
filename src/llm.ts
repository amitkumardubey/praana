import type { PraanaConfig, UserProviderConfig, UserProviderModel } from "./types.js";
import { mapProviderToPiAi, resolveContextWindowSync, isInPiAiCatalog, normalizeModelIdForProvider } from "./model-context.js";
import { getAppLogger } from "./logger.js";
import {
  PROVIDER_REGISTRY,
  REASONING_MODEL_HINTS,
  getProviderEnvKey,
  getProviderEnvKeys,
  getUserProviderRegistryEntry,
  isUserDeclaredProvider,
  getUserProviderConfig,
  listUserDeclaredProviderIds,
  type ProviderConfig,
} from "./provider-registry.js";
import { resolveApiKey, hasApiKey, hasCredentials } from "./credentials.js";
import {
  isBedrockAvailable,
  getBedrockMissingCredentialsMessage,
  resolveBedrockBearerToken,
} from "./bedrock/credentials.js";
import { resolveBedrockRegion } from "./bedrock/region.js";
import { isOAuthOnlyProvider, supportsOAuthLogin } from "./oauth.js";
import { getCuratedModels, getModelCatalogEntry } from "./llm/catalog.js";
import { DEFAULT_MODELS as NATIVE_DEFAULT_MODELS } from "./llm/resolver.js";

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
export {
  resolveApiKey,
  hasApiKey,
  hasCredentials,
  getApiKey,
  setApiKey,
} from "./credentials.js";

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
  "poolside",
  "openrouter",
  "amazon-bedrock",
  "ollama",
];

export const DEFAULT_MODELS: Record<string, string> = {
  ...NATIVE_DEFAULT_MODELS,
  mistral: "mistral-large-latest",
  xai: "grok-2",
  fireworks: "accounts/fireworks/models/llama-v3p1-70b-instruct",
  together: "meta-llama/Llama-3.1-70B-Instruct-Turbo",
  opencode: "gpt-4o",
  umans: "umans-coder",
  poolside: "poolside/laguna-s-2.1",
  "openai-codex": "gpt-5.4",
  "github-copilot": "gpt-4.1",
};

export function pickFirstCatalogModel(provider: string): string | undefined {
  const models = getCuratedModels(provider);
  return models?.[0]?.id;
}

/**
 * List providers that currently have a usable key (credential store or env).
 */
export function listEnvDetectedProviders(): string[] {
  return listAvailableProviders();
}

/**
 * @deprecated Prefer {@link listEnvDetectedProviders}.
 */
export function detectProviderFromEnvironment(): { provider: string; model: string } | null {
  const logger = getAppLogger().child("llm");

  for (const provider of DETECTION_PRECEDENCE) {
    if (isProviderAvailable(provider)) {
      const model = DEFAULT_MODELS[provider] ?? pickFirstCatalogModel(provider) ?? "";
      logger.debug(`Detected available provider "${provider}"`, {
        details: { provider, model },
      });
      return { provider, model };
    }
  }

  logger.debug("No provider API key found in environment");
  return null;
}

/** Return all available providers. */
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

/** Return all known provider names. */
export function listKnownProviders(): string[] {
  const registryIds = Object.keys(PROVIDER_REGISTRY);
  const userIds = listUserDeclaredProviderIds();
  return Array.from(new Set([...registryIds, ...userIds])).sort();
}

/**
 * Check whether a provider is available to use.
 */
export function isProviderAvailable(provider: string): boolean {
  if (isUserDeclaredProvider(provider)) {
    const userEntry = getUserProviderRegistryEntry(provider);
    if (!userEntry) return false;
    if (!userEntry.envKey) return true;
    return hasApiKey(provider) || !!process.env[userEntry.envKey]?.trim();
  }

  if (hasCredentials(provider)) return true;

  if (provider === "amazon-bedrock") {
    return isBedrockAvailable();
  }

  if (provider === "ollama") {
    return true;
  }

  const keys = getProviderEnvKeys(provider);
  if (keys.length === 0) {
    return false;
  }

  return keys.some((k) => !!process.env[k]?.trim());
}

/** Human-readable message explaining which env var is missing. */
export function getMissingKeyMessage(provider: string): string | null {
  if (!provider || !provider.trim()) {
    return "No provider configured";
  }

  if (isProviderAvailable(provider)) return null;

  if (provider === "amazon-bedrock") {
    return getBedrockMissingCredentialsMessage();
  }

  if (supportsOAuthLogin(provider)) {
    if (isOAuthOnlyProvider(provider)) {
      return `Not authenticated. Run /login ${provider} to sign in via OAuth.`;
    }
    return `Missing credentials. Run /login ${provider} (API key or OAuth), or set ${getProviderEnvKey(provider) ?? "an API key"}.`;
  }

  const envKey = getProviderEnvKey(provider);
  if (envKey && PROVIDER_REGISTRY[provider]) {
    return `Missing required env var: ${envKey}`;
  }

  return `Provider "${provider}" is not configured`;
}

/** Whether a model likely requires chain-of-thought enabled on the wire. */
export function inferReasoningModel(provider: string, modelId: string): boolean {
  const providerHints = REASONING_MODEL_HINTS[provider];
  const globalHints = REASONING_MODEL_HINTS["*"];
  for (const hints of [providerHints, globalHints]) {
    if (hints?.some((h) => h.pattern.test(modelId))) return true;
  }
  const entry = getModelCatalogEntry(provider, modelId);
  return !!entry?.reasoning;
}

type RuntimeModel = Record<string, unknown> & {
  __piOptions?: Record<string, unknown>;
};

export function getProviderConfig(provider: string): ProviderConfig {
  const userEntry = getUserProviderRegistryEntry(provider);
  if (userEntry) return userEntry;
  const entry = PROVIDER_REGISTRY[provider];
  if (entry) return entry;
  return {
    api: "openai-completions",
    provider,
    envKey: null,
    baseUrl: "https://api.openai.com/v1",
  };
}

function getUserDeclaredModel(
  provider: string,
  modelId: string,
): UserProviderModel | undefined {
  const userConfig = getUserProviderConfig(provider);
  if (!userConfig?.models) return undefined;
  return userConfig.models.find((m) => m.id === modelId);
}

function buildModel(
  config: PraanaConfig["llm"],
  modelId: string,
  contextWindow?: number,
): RuntimeModel {
  const normalizedId = normalizeModelIdForProvider(config.provider, modelId);
  const pc = getProviderConfig(config.provider);
  const baseUrl = config.base_url ?? pc.baseUrl;
  const apiKey = resolveApiKey(config.provider, pc.envKey, pc.envKeyAliases);
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

  if (pc.compat) {
    model.compat = { ...pc.compat };
  }

  if (config.provider === "amazon-bedrock") {
    model.__piOptions = {
      region: resolveBedrockRegion(config),
      ...(resolveBedrockBearerToken() ? { bearerToken: resolveBedrockBearerToken() } : {}),
    };
  } else {
    model.__piOptions = {
      apiKey,
      headers: pc.headers ? { ...pc.headers } : undefined,
    };
  }

  return model;
}

export function createProvider(config: PraanaConfig["llm"], contextWindow?: number) {
  return (modelId: string) => buildModel(config, modelId, contextWindow);
}

export function resolveModel(modelString: string) {
  return modelString;
}

// ── Reasoning / thinking-level helpers ────────────────────────

export const REASONING_EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

const DEFAULT_REASONING_LEVEL: ReasoningEffortLevel = "medium";

export function parseReasoningEffort(raw: string): ReasoningEffortLevel | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "none") return "off";
  if ((REASONING_EFFORT_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as ReasoningEffortLevel;
  }
  return null;
}

export function getReasoningEffort(
  model: Record<string, unknown>,
  modelId: string,
  provider: string,
  preferred?: string | null,
): string | undefined {
  const needsReasoning =
    !!model.reasoning || inferReasoningModel(provider, modelId);
  if (!needsReasoning) return undefined;

  const preferredLevel =
    preferred != null && preferred !== ""
      ? parseReasoningEffort(preferred)
      : null;
  let requested = preferredLevel ?? DEFAULT_REASONING_LEVEL;
  if (requested === "off" && inferReasoningModel(provider, modelId)) {
    requested = "minimal";
  }
  if (requested === "off") return undefined;
  return requested;
}
