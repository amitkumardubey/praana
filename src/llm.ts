import { getModel, getEnvApiKey, getProviders, findEnvKeys, clampThinkingLevel } from "@earendil-works/pi-ai";
import type { PraanaConfig } from "./types.js";
import { mapProviderToPiAi, resolveContextWindowSync, isInPiAiCatalog, normalizeModelIdForProvider } from "./model-context.js";
import { getAppLogger } from "./logger.js";
import {
  PROVIDER_REGISTRY,
  REASONING_MODEL_HINTS,
  type ProviderConfig,
} from "./provider-registry.js";

export {
  resolveContextWindowSync,
  fetchAndCacheContextWindow,
  DEFAULT_MODEL_CONTEXT_WINDOW,
} from "./model-context.js";

export type { ProviderConfig } from "./provider-registry.js";

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
  "openrouter",
  "ollama",
];

/** Default model for each provider when auto-detecting. */
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
};

/**
 * Auto-detect the first available provider from environment variables.
 * Returns `{ provider, model }` or `null` if nothing is found.
 */
export function detectProviderFromEnvironment(): { provider: string; model: string } | null {
  const logger = getAppLogger().child("llm");

  for (const provider of DETECTION_PRECEDENCE) {
    if (isProviderAvailable(provider)) {
      const model = DEFAULT_MODELS[provider] ?? "";
      logger.info(`Auto-detected provider "${provider}" from environment`, {
        details: { provider, model },
      });
      return { provider, model };
    }
  }

  logger.debug("No provider API key found in environment");
  return null;
}

/** Return all available providers in detection-precedence order. */
export function listAvailableProviders(): string[] {
  return DETECTION_PRECEDENCE.filter(isProviderAvailable);
}

// ── Exported helpers ───────────────────────────────────────────

/** Lookup a provider config. Falls back to openrouter for unknown values. */
export function getProviderConfig(provider: string): ProviderConfig {
  const entry = PROVIDER_REGISTRY[provider];
  if (!entry) {
    getAppLogger().child("llm").warn(
      `Unknown provider "${provider}", falling back to openrouter. Known providers: ${listKnownProviders().join(", ")}`,
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
  const registryEntry = PROVIDER_REGISTRY[provider];

  // 1. Providers explicitly marked keyless in the registry (ollama, bedrock).
  if (registryEntry && registryEntry.envKey === null) return true;

  // 2. Registry entry with an env key — check if that env var is set.
  //    This takes precedence over pi-ai's detection to avoid false positives
  //    for providers that ARE in our registry (e.g. opencode).
  if (registryEntry?.envKey) {
    return !!process.env[registryEntry.envKey];
  }

  // 3. For providers known to pi-ai but NOT in our registry, use pi-ai's
  //    key detection.  Only treat as available when pi-ai confirms the key
  //    is present; otherwise default to unavailable (safer for providers we
  //    don't explicitly manage).
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

  const apiKey = getEnvApiKey(piProvider as never) ?? "no-key";

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
  const apiKey = pc.envKey ? (process.env[pc.envKey] ?? "") : "no-key";

  const model: RuntimeModel = {
    id: normalizedId,
    name: normalizedId,
    provider: pc.provider,
    api: pc.api,
    baseUrl,
    input: ["text"],
    reasoning: inferReasoningModel(config.provider, normalizedId),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow:
      contextWindow ??
      resolveContextWindowSync(config.provider, normalizedId, config.context_window),
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
