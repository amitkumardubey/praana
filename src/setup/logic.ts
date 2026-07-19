import { getAppLogger } from "../logger.js";
import { getProviderEnvKey, isUserDeclaredProvider } from "../provider-registry.js";
import {
  isProviderAvailable,
  setApiKey,
  DEFAULT_MODELS,
  pickFirstCatalogModel,
  listKnownProviders,
  listEnvDetectedProviders,
  hasApiKey,
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
 * Read a provider's API key from the environment (not the credential store).
 * Returns the trimmed value, or null if unset/empty or the provider has no env key.
 */
export function getEnvApiKeyForProvider(provider: string): string | null {
  const envKey = getProviderEnvKey(provider);
  if (!envKey) return null;
  const value = process.env[envKey];
  if (!value || !value.trim()) return null;
  return value.trim();
}

/**
 * Offer copy for the wizard when an env key is present but not yet in the store.
 * Returns null when there is nothing to offer.
 */
export function formatEnvKeyOfferMessage(provider: string): string | null {
  const envKey = getProviderEnvKey(provider);
  if (!envKey || !getEnvApiKeyForProvider(provider)) return null;
  return `Found ${envKey} in your environment — use it?`;
}

/**
 * Copy a provider's env key into the credential store.
 * Returns true when a key was adopted and saved.
 */
export function adoptEnvKeyForProvider(provider: string): boolean {
  const value = getEnvApiKeyForProvider(provider);
  if (!value) return false;
  return saveProviderKey(provider, value);
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

// ── Auto-select (power-user fast path) ──

/**
 * Result of auto-selecting a single available provider on first run.
 * - `adoptedFromEnv=true` means the env key was copied into the credential store.
 * - `adoptedFromEnv=false` means the key was already in the store (nothing copied).
 */
export interface AutoSelectResult {
  provider: string;
  model: string;
  envKey: string;
  adoptedFromEnv: boolean;
}

/**
 * Auto-select a single available provider for true first-run (no config file).
 *
 * Returns null in any ambiguous case — the wizard handles those:
 *   - 0 key-requiring providers available
 *   - >1 key-requiring providers available (user must choose)
 *   - the only available provider is user-declared (needs base_url in config)
 *   - the only available provider is keyless (e.g. ollama — wizard handles it)
 *
 * Keyless providers (envKey === null) are excluded from the candidate set
 * because they don't represent the "power user with one env key" use case.
 *
 * When exactly one key-requiring provider is available:
 *   - If its key is in env but not in the credential store → adopt it (copy env → store).
 *   - If its key is already in the store → nothing to copy.
 *   - Picks DEFAULT_MODELS[provider] as the model (NO live catalog fetch — zero latency).
 *
 * Works in BOTH interactive and non-interactive modes (checks env/store, not TTY).
 */
export function tryAutoSelectProvider(): AutoSelectResult | null {
  // Only consider providers that require a key (have an env_key).
  // Keyless providers (ollama) and user-declared providers are excluded —
  // the wizard handles those.
  const available = listEnvDetectedProviders().filter(
    (p) => !isUserDeclaredProvider(p) && getProviderEnvKey(p) !== null,
  );
  if (available.length !== 1) return null;
  const provider = available[0];
  const envKey = getProviderEnvKey(provider);
  if (!envKey) return null; // defensive — filtered above, but TS can't infer
  const envValue = getEnvApiKeyForProvider(provider);
  const hasStoredKey = hasApiKey(provider);
  // If there's no stored key and no usable env key, we can't actually
  // use this provider — fall through to the wizard. This handles
  // whitespace-only env values (isProviderAvailable returns true for
  // truthy strings, but getEnvApiKeyForProvider returns null after trimming).
  if (!hasStoredKey && !envValue) return null;
  let adoptedFromEnv = false;
  if (envValue && !hasStoredKey) {
    adoptedFromEnv = saveProviderKey(provider, envValue);
  }
  const model = pickDefaultModel(provider);
  return { provider, model, envKey, adoptedFromEnv };
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
 * Must start with http:// or https://, and must not contain characters
 * that would break TOML string interpolation or inject config lines.
 */
export function isValidBaseUrl(
  url: string,
): { valid: boolean; error?: string } {
  if (!url) return { valid: false, error: "Base URL is required" };
  if (!/^https?:\/\//.test(url)) {
    return { valid: false, error: "Must start with http:// or https://" };
  }
  if (/[\x00-\x1f\x7f"]/.test(url)) {
    return {
      valid: false,
      error: "Must not contain quotes or control characters",
    };
  }
  try {
    // Reject obviously malformed URLs while still allowing localhost/LAN.
    void new URL(url);
  } catch {
    return { valid: false, error: "Must be a valid URL" };
  }
  return { valid: true };
}

/**
 * True when a catalog provider needs an API key (has a named env key).
 * Keyless / externally-configured providers (envKey === null) are excluded
 * from the interactive picker, but this helper keeps the key-entry gate
 * explicit for catalog flows.
 */
export function providerRequiresApiKey(provider: string): boolean {
  return getProviderEnvKey(provider) !== null;
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
