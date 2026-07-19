// ============================================================
// PRAANA — Credential Store
// ============================================================
//
// File-backed API key store at ~/.praana/credentials.json (0o600).
// Keys are looked up by provider id. This is the primary key
// resolution path; env vars (env_key) are a fallback for backward
// compatibility and CI/headless use.
//
// Schema:
//   {
//     "openrouter": { "key": "sk-...", "savedAt": 1720000000000 },
//     "my-llama":   { "key": "tok-...", "savedAt": 1720000000000 }
//   }

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { appHomePath } from "./app-identity.js";
import { getAppLogger } from "./logger.js";

const FILE_MODE = 0o600;

/**
 * Resolve the credentials file path lazily on each call so that
 * PRAANA_HOME overrides (e.g. in tests) take effect after the module
 * is loaded.
 */
function credentialsFilePath(): string {
  return appHomePath("credentials.json");
}

interface StoredCredential {
  key: string;
  savedAt: number;
}

interface CredentialsFile {
  [providerId: string]: StoredCredential;
}

let memoryCache: CredentialsFile | null = null;

function loadCredentials(): CredentialsFile {
  if (memoryCache) return memoryCache;

  const credPath = credentialsFilePath();
  if (!existsSync(credPath)) {
    memoryCache = {};
    return memoryCache;
  }

  try {
    const raw = readFileSync(credPath, "utf-8");
    const parsed = JSON.parse(raw) as CredentialsFile;
    memoryCache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    getAppLogger().child("credentials").warn(
      "Failed to read credentials store, treating as empty",
      { cause: err as Error, code: "CREDENTIALS_READ_FAILED" },
    );
    memoryCache = {};
  }
  return memoryCache;
}

function persistCredentials(creds: CredentialsFile): void {
  const credPath = credentialsFilePath();
  const dir = dirname(credPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(credPath, JSON.stringify(creds, null, 2), "utf-8");

  // Ensure restrictive permissions (owner-only read/write).
  try {
    chmodSync(credPath, FILE_MODE);
  } catch {
    // chmod can fail on some platforms (e.g. Windows). The file is still
    // written; the mode is best-effort on those systems.
  }

  memoryCache = creds;
}

/**
 * Get the API key for a provider from the credential store.
 * Returns undefined if no key is stored.
 */
export function getApiKey(provider: string): string | undefined {
  const creds = loadCredentials();
  const entry = creds[provider];
  return entry?.key || undefined;
}

/**
 * Store an API key for a provider. Creates or overwrites the entry.
 */
export function setApiKey(provider: string, key: string): void {
  const creds = loadCredentials();
  creds[provider] = { key, savedAt: Date.now() };
  persistCredentials(creds);
}

/**
 * Remove a provider's credentials from the store.
 * Returns true if a key was removed, false if none existed.
 */
export function removeApiKey(provider: string): boolean {
  const creds = loadCredentials();
  if (!(provider in creds)) return false;
  delete creds[provider];
  persistCredentials(creds);
  return true;
}

/**
 * List all provider ids that have a stored credential.
 */
export function listStoredProviders(): string[] {
  const creds = loadCredentials();
  return Object.keys(creds);
}

/**
 * Check whether a provider has a key in the credential store.
 */
export function hasApiKey(provider: string): boolean {
  const creds = loadCredentials();
  return !!creds[provider]?.key;
}

/**
 * Resolve the API key for a provider with fallback chain:
 *   1. Credential store (~/.praana/credentials.json)
 *   2. Environment variable (envKey, if provided)
 *   3. undefined (no key available)
 *
 * For keyless providers (e.g. local Ollama), returns "no-key" sentinel
 * when no key is found and no envKey is provided.
 */
export function resolveApiKey(
  provider: string,
  envKey?: string | null,
): string {
  // 1. Credential store
  const stored = getApiKey(provider);
  if (stored) return stored;

  // 2. Environment variable
  if (envKey) {
    const envValue = process.env[envKey];
    if (envValue) return envValue;
  }

  // 3. No key — keyless providers use "no-key" sentinel
  return "no-key";
}

/** @internal — returns the credentials file path (for tests/display). */
export function getCredentialsFilePath(): string {
  return credentialsFilePath();
}

/**
 * Ensure the credentials file has restrictive permissions.
 * Called on startup to fix up files created before the 0o600 enforcement.
 */
export function ensureCredentialsFileMode(): void {
  const credPath = credentialsFilePath();
  if (!existsSync(credPath)) return;
  try {
    const stat = statSync(credPath);
    // Only fix if the file is more permissive than 0o600.
    if ((stat.mode & 0o077) !== 0) {
      chmodSync(credPath, FILE_MODE);
    }
  } catch {
    // Best-effort.
  }
}

/** Test helper — reset in-memory cache so the next read hits disk. */
export function resetCredentialStoreForTests(): void {
  memoryCache = null;
}
