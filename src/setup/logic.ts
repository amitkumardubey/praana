import { getAppLogger } from "../logger.js";
import { getProviderEnvKey, isUserDeclaredProvider } from "../provider-registry.js";
import {
  isProviderAvailable,
  setApiKey,
  DEFAULT_MODELS,
  pickFirstCatalogModel,
  listKnownProviders,
} from "../llm.js";
import {
  listProviderCatalogModels,
  fetchModelsFromEndpoint,
  type ProviderCatalogModelEntry,
} from "../provider-catalog.js";
import { writeProviderConfig } from "./config-writer.js";
import type { SetupResult, CustomProviderConfig } from "./types.js";

export interface ProviderSetupInfo {
  provider: string;
  envKey: string | null;
  keyDetected: boolean;
  needsExternalConfig: boolean;
}

export function describeProviderSetup(provider: string): ProviderSetupInfo {
  const envKey = getProviderEnvKey(provider);
  return {
    provider,
    envKey,
    keyDetected: isProviderAvailable(provider),
    needsExternalConfig: envKey === null && !isProviderAvailable(provider),
  };
}

/**
 * Save an API key to the credential store.
 * Returns true if the key was saved.
 */
export function saveProviderKey(provider: string, key: string): boolean {
  if (!key.trim()) return false;
  setApiKey(provider, key.trim());
  return true;
}

/**
 * Fetch the model list for a catalog provider (best-effort).
 * Returns the model entries, or null if the fetch failed.
 */
export async function fetchProviderModels(
  provider: string,
): Promise<ProviderCatalogModelEntry[] | null> {
  try {
    return await listProviderCatalogModels(provider);
  } catch {
    return null;
  }
}

/**
 * Fetch the model list from a custom OpenAI-compatible endpoint (best-effort).
 * Returns the model entries, or null if the fetch failed.
 */
export async function fetchCustomProviderModels(
  baseUrl: string,
  apiKey?: string,
): Promise<ProviderCatalogModelEntry[] | null> {
  try {
    return await fetchModelsFromEndpoint(baseUrl, apiKey);
  } catch {
    return null;
  }
}

/**
 * Pick a default model for a provider.
 * Tries: first live-catalog model → explicit default → first pi-ai catalog model → empty.
 */
export function pickDefaultModel(
  provider: string,
  liveModels?: ProviderCatalogModelEntry[] | null,
): string {
  if (liveModels && liveModels.length > 0) return liveModels[0].id;
  return DEFAULT_MODELS[provider] ?? pickFirstCatalogModel(provider) ?? "";
}

// ── Custom provider validation ──

/**
 * Validate a custom provider id.
 * Must be lowercase, no spaces, and not already a known provider.
 */
export function isValidCustomProviderId(
  id: string,
): { valid: boolean; error?: string } {
  if (!id) return { valid: false, error: "Provider id is required" };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    return {
      valid: false,
      error: "Must be lowercase letters, numbers, and hyphens only",
    };
  }
  const known = new Set(listKnownProviders());
  if (known.has(id)) {
    return { valid: false, error: `"${id}" is already a known provider id` };
  }
  if (isUserDeclaredProvider(id)) {
    return { valid: false, error: `"${id}" is already declared in your config` };
  }
  return { valid: true };
}

/**
 * Validate a base URL.
 * Must start with http:// or https://.
 */
export function isValidBaseUrl(
  url: string,
): { valid: boolean; error?: string } {
  if (!url) return { valid: false, error: "Base URL is required" };
  if (!/^https?:\/\//.test(url)) {
    return { valid: false, error: "Must start with http:// or https://" };
  }
  return { valid: true };
}

export function finalizeProviderSetup(
  provider: string,
  configAction: "write" | "skip" | "overwrite",
  opts?: {
    model?: string;
    customProvider?: CustomProviderConfig;
    keySaved?: boolean;
  },
): SetupResult {
  const info = describeProviderSetup(provider);
  const logger = getAppLogger().child("app");

  if (configAction === "skip") {
    logger.info(`Interactive setup completed for provider: ${provider}`, {
      details: { provider, configWritten: false },
    });
    return {
      success: true,
      provider,
      model: opts?.model,
      keySaved: opts?.keySaved ?? false,
      message: info.keyDetected
        ? `Provider ${provider} is already configured.`
        : `Setup notes recorded for ${provider}.`,
    };
  }

  const writeResult = writeProviderConfig(provider, {
    force: configAction === "overwrite",
    model: opts?.model,
    customProvider: opts?.customProvider,
  });

  if (!writeResult.written && configAction === "write") {
    return {
      success: true,
      provider,
      message: writeResult.message,
    };
  }

  logger.info(`Interactive setup completed for provider: ${provider}`, {
    details: { provider, configWritten: writeResult.written, path: writeResult.path },
  });

  const keySaved = opts?.keySaved ?? false;
  const message = writeResult.written
    ? keySaved
      ? `Key saved to ~/.praana/credentials.json. Config created at ${writeResult.path}. PRAANA is ready.`
      : writeResult.message
    : writeResult.message;

  return {
    success: true,
    provider,
    model: opts?.model,
    keySaved,
    message,
  };
}
