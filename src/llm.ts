import type { PraanaConfig, UserProviderConfig, UserProviderModel } from "./types.js";
import { resolveContextWindowSync, normalizeModelIdForProvider } from "./model-context.js";
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
  type ProviderWireCompat,
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
import { openaiChatOverrideCompat, openaiUsesResponses, shouldUseOpenAIResponses } from "./llm/openai-routing.js";
import {
  parseReasoningEffort,
  type ReasoningEffortLevel,
} from "./reasoning-levels.js";

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
  "openai-codex": "gpt-6.1-sol",
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

/**
 * Whether a configured base_url counts as an explicit override. An empty
 * string is treated the same as an unset value by both routing and the
 * wire-compat handling below.
 */
function baseUrlIsSet(baseUrl: string | undefined): boolean {
  return baseUrl !== undefined && baseUrl !== "";
}

/** Whether a model likely requires chain-of-thought enabled on the wire. */
export function inferReasoningModel(
  provider: string,
  modelId: string,
  opts: { firstPartyResponses?: boolean } = {},
): boolean {
  // First-party OpenAI Responses models (GPT-5.4+) enable reasoning effort by
  // default. This is a property of the first-party Responses route, not of the
  // model id: gateways, Chat overrides, and user-declared providers keep the
  // generic hint-based behavior.
  if (opts.firstPartyResponses && provider === "openai" && openaiUsesResponses(modelId)) return true;
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
  const baseUrl = baseUrlIsSet(config.base_url) ? config.base_url : pc.baseUrl;
  const apiKey = resolveApiKey(config.provider, pc.envKey, pc.envKeyAliases);
  const userModel = getUserDeclaredModel(config.provider, normalizedId);
  const firstPartyResponses = shouldUseOpenAIResponses({
    provider: config.provider, model: normalizedId, baseUrl,
    baseUrlOverride: baseUrlIsSet(config.base_url),
  });

  const model: RuntimeModel = {
    id: normalizedId,
    name: normalizedId,
    provider: pc.provider,
    api: firstPartyResponses ? "openai-responses" : userModel?.api ?? pc.api,
    baseUrl,
    ...(baseUrlIsSet(config.base_url) ? { baseUrlOverride: true } : {}),
    input: ["text"],
    reasoning: userModel?.reasoning ?? inferReasoningModel(config.provider, normalizedId, { firstPartyResponses }),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow:
      userModel?.context_window ??
      contextWindow ??
      resolveContextWindowSync(config.provider, normalizedId, config.context_window),
    maxTokens: userModel?.max_tokens ?? 8192,
  };

  const wireCompat = pc.compat ?? openaiChatOverrideCompat(config.provider);
  if (wireCompat) {
    const compat: ProviderWireCompat = { ...wireCompat };
    // A configured base_url points at a gateway, not the vendor's own endpoint,
    // so drop the vendor-specific field name and keep the generic default.
    if (config.base_url && compat.maxTokensField) {
      delete compat.maxTokensField;
    }
    model.compat = compat;
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

export {
  REASONING_EFFORT_LEVELS,
  parseReasoningEffort,
  type ReasoningEffortLevel,
} from "./reasoning-levels.js";

const DEFAULT_REASONING_LEVEL: ReasoningEffortLevel = "medium";

export function getReasoningEffort(
  model: Record<string, unknown>,
  modelId: string,
  provider: string,
  preferred?: string | null,
  opts: { firstPartyResponses?: boolean } = {},
): string | undefined {
  const needsReasoning =
    !!model.reasoning || inferReasoningModel(provider, modelId, opts);
  if (!needsReasoning) return undefined;

  const preferredLevel =
    preferred != null && preferred !== ""
      ? parseReasoningEffort(preferred)
      : null;
  let requested: string = preferredLevel ?? DEFAULT_REASONING_LEVEL;
  if (requested === "off") {
    if (opts.firstPartyResponses && provider === "openai" && openaiUsesResponses(modelId)) {
      // First-party Responses rejects "minimal" (and omits reasoning entirely
      // for many models); "off" maps to the supported "none" level.
      requested = "none";
    } else if (inferReasoningModel(provider, modelId, opts)) {
      requested = "minimal";
    } else {
      return undefined;
    }
  }
  return requested;
}
