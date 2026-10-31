// ============================================================
// PRAANA — Credential Store
// ============================================================
//
// File-backed credential store at ~/.praana/credentials.json (0o600).
// Supports static API keys and OAuth token bundles (access/refresh/expiry).
// Keys are looked up by provider id. This is the primary credential
// resolution path; env vars (env_key) are a fallback for backward
// compatibility and CI/headless use.
//
// Schema:
//   {
//     "openrouter": { "type": "api_key", "key": "sk-...", "savedAt": 1720000000000 },
//     "openai-codex": {
//       "type": "oauth",
//       "access": "...",
//       "refresh": "...",
//       "expires": 1720003600000,
//       "savedAt": 1720000000000
//     }
//   }
//
// Legacy entries without `type` and with a non-empty `key` are treated as api_key.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { appHomePath } from "./app-identity.js";
import {
  acquireAsync,
  acquireSync,
  CredentialLockTimeoutError,
  resetCredentialLocksForTests,
  type CredentialLock,
} from "./credential-lock.js";
import { getAppLogger } from "./logger.js";

const FILE_MODE = 0o600;
/** Store-lock wait. Holders only rewrite the file synchronously, so the wait stays short. */
const STORE_LOCK_WAIT_MS = 2_000;
const REFRESH_LOCK_POLL_MS = 100;

/**
 * Resolve the credentials file path lazily on each call so that
 * PRAANA_HOME overrides (e.g. in tests) take effect after the module
 * is loaded.
 */
function credentialsFilePath(): string {
  return appHomePath("credentials.json");
}

export interface StoredApiKeyCredential {
  type?: "api_key";
  key: string;
  savedAt: number;
}

export interface StoredOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  savedAt: number;
  /** Provider-specific extras (e.g. Copilot enterpriseUrl). */
  [key: string]: unknown;
}

export type StoredCredential = StoredApiKeyCredential | StoredOAuthCredential;

export type ResolvedAuth =
  | { kind: "api_key"; apiKey: string }
  | { kind: "oauth"; apiKey: string; expires: number }
  | { kind: "env"; apiKey: string }
  | { kind: "none"; apiKey: string };

interface CredentialsFile {
  [providerId: string]: StoredCredential;
}

let memoryCache: CredentialsFile | null = null;
let credentialsMtimeMs: number | null = null;
let credentialContentReads = 0;
/**
 * Reentrancy for the store lock only. The counter is safe because the critical
 * section is synchronous: no other turn can run until it returns. It must never
 * stay raised across an await.
 */
let storeLockDepth = 0;
const heldRefreshLocks = new Map<string, CredentialLock>();

function credentialsLockPath(): string {
  return join(dirname(credentialsFilePath()), "credentials.lock.db");
}

function refreshLockPath(provider: string): string {
  const safe = provider.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(dirname(credentialsFilePath()), `credentials.refresh-${safe}.lock.db`);
}

/**
 * Store lock. Synchronous on purpose: the caller must not await while it is
 * held. Waiters block at most 2 seconds because a holder only reads and
 * rewrites credentials.json. The operating system drops the lock if this
 * process dies.
 */
function withStoreLockSync<T>(fn: () => T): T {
  if (storeLockDepth > 0) return fn();
  const lock = acquireSync(credentialsLockPath(), { waitMs: STORE_LOCK_WAIT_MS });
  storeLockDepth += 1;
  try {
    return fn();
  } finally {
    storeLockDepth -= 1;
    lock.release();
  }
}

/** Short critical section around a credentials.json read or rewrite. Never await inside `fn`. */
export function withCredentialStoreLockSync<T>(fn: () => T): T {
  return withStoreLockSync(fn);
}

/**
 * Per-provider refresh lock. Waiters sleep asynchronously so the event loop
 * stays free while another session refreshes. Returns false when `waitMs` elapses.
 * The rotated credential is persisted before the caller releases this lock.
 */
export async function waitForProviderRefreshLock(provider: string, waitMs: number): Promise<boolean> {
  try {
    const lock = await acquireAsync(refreshLockPath(provider), {
      waitMs,
      pollMs: REFRESH_LOCK_POLL_MS,
    });
    heldRefreshLocks.set(provider, lock);
    return true;
  } catch (err) {
    if (err instanceof CredentialLockTimeoutError) return false;
    throw err;
  }
}

export function releaseProviderRefreshLock(provider: string): void {
  const lock = heldRefreshLocks.get(provider);
  heldRefreshLocks.delete(provider);
  lock?.release();
}

function cloneCredentials(creds: CredentialsFile): CredentialsFile {
  return structuredClone(creds);
}

function runCredentialMutation<T>(mutator: (creds: CredentialsFile) => T): T {
  return withStoreLockSync(() => {
    const creds = cloneCredentials(readCredentialsFromDisk());
    const result = mutator(creds);
    persistCredentials(creds);
    return result;
  });
}

/** @internal A throw must leave the cache and the file unchanged. */
export function mutateCredentialsForTests(mutator: (creds: CredentialsFile) => void): void {
  runCredentialMutation(mutator);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthEntry(entry: StoredCredential): entry is StoredOAuthCredential {
  return entry.type === "oauth";
}

function sanitizeCredentials(parsed: unknown): CredentialsFile {
  if (!isPlainObject(parsed)) return {};
  const out: CredentialsFile = {};
  for (const [providerId, entry] of Object.entries(parsed)) {
    if (!isPlainObject(entry)) continue;
    const savedAt =
      typeof entry.savedAt === "number" && Number.isFinite(entry.savedAt)
        ? entry.savedAt
        : Date.now();

    if (entry.type === "oauth") {
      if (typeof entry.access !== "string" || !entry.access) continue;
      if (typeof entry.refresh !== "string" || !entry.refresh) continue;
      if (typeof entry.expires !== "number" || !Number.isFinite(entry.expires)) continue;
      const oauth: StoredOAuthCredential = {
        type: "oauth",
        access: entry.access,
        refresh: entry.refresh,
        expires: entry.expires,
        savedAt,
      };
      for (const [k, v] of Object.entries(entry)) {
        if (k === "type" || k === "access" || k === "refresh" || k === "expires" || k === "savedAt") {
          continue;
        }
        oauth[k] = v;
      }
      out[providerId] = oauth;
      continue;
    }

    // Legacy / api_key entries.
    if (typeof entry.key !== "string" || !entry.key) continue;
    out[providerId] = { type: "api_key", key: entry.key, savedAt };
  }
  return out;
}

function rememberCredentialsMtime(): void {
  try {
    credentialsMtimeMs = statSync(credentialsFilePath()).mtimeMs;
  } catch {
    credentialsMtimeMs = null;
  }
}

function noteCredentialContentRead(): void {
  credentialContentReads += 1;
}

/** How many times this process has read credentials.json contents. */
export function credentialDiskReadCountForTests(): number {
  return credentialContentReads;
}

/**
 * Memory-cache lookup that does not read file contents.
 * `unchanged` is false when the cache is cold or the file mtime moved.
 */
export function readCachedOAuthIfUnchanged(
  provider: string,
): { unchanged: true; token: StoredOAuthCredential | undefined } | { unchanged: false } {
  if (memoryCache === null || credentialsMtimeMs === null) return { unchanged: false };
  let mtime: number;
  try {
    mtime = statSync(credentialsFilePath()).mtimeMs;
  } catch {
    return { unchanged: false };
  }
  if (mtime !== credentialsMtimeMs) return { unchanged: false };
  const entry = memoryCache[provider];
  if (!entry || !isOAuthEntry(entry)) return { unchanged: true, token: undefined };
  return { unchanged: true, token: entry };
}

function credentialStoreReadError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code;
  const error = new Error(
    `Failed to read the credentials store${code ? ` (${code})` : ""}; left it unchanged`,
  );
  error.name = "CredentialStoreReadError";
  (error as Error & { cause?: unknown }).cause = err;
  return error;
}

/** Always read the file. Locked mutations must not trust memoryCache. Throws when the file cannot be read. */
function readCredentialsFromDisk(): CredentialsFile {
  const credPath = credentialsFilePath();
  if (!existsSync(credPath)) {
    memoryCache = {};
    credentialsMtimeMs = null;
    return memoryCache;
  }
  let raw: string;
  try {
    raw = readFileSync(credPath, "utf-8");
  } catch (err) {
    throw credentialStoreReadError(err);
  }
  noteCredentialContentRead();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw credentialStoreReadError(err);
  }
  memoryCache = sanitizeCredentials(parsed);
  rememberCredentialsMtime();
  return memoryCache;
}

/** Disk read of one OAuth entry. Does not take the credential lock. */
export function readOAuthTokenFromDisk(provider: string): StoredOAuthCredential | undefined {
  const entry = readCredentialsFromDisk()[provider];
  if (!entry || !isOAuthEntry(entry)) return undefined;
  return entry;
}

function loadCredentials(): CredentialsFile {
  if (memoryCache) return memoryCache;
  try {
    return readCredentialsFromDisk();
  } catch (err) {
    getAppLogger().child("credentials").warn(
      "Failed to read credentials store, treating as empty",
      { cause: err instanceof Error ? err : new Error(String(err)), code: "CREDENTIALS_READ_FAILED" },
    );
    memoryCache = {};
    credentialsMtimeMs = null;
    return memoryCache;
  }
}

function persistCredentials(creds: CredentialsFile): void {
  const credPath = credentialsFilePath();
  const dir = dirname(credPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Atomic write: temp file with restrictive mode, then rename.
  const tmpPath = join(dir, `.credentials.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(creds, null, 2);
  writeFileSync(tmpPath, payload, { encoding: "utf-8", mode: FILE_MODE });
  try {
    chmodSync(tmpPath, FILE_MODE);
  } catch {
    // chmod can fail on some platforms (e.g. Windows). Best-effort.
  }
  renameSync(tmpPath, credPath);
  try {
    chmodSync(credPath, FILE_MODE);
  } catch {
    // Best-effort heal after rename (some FS ignore mode on create).
  }

  memoryCache = creds;
  rememberCredentialsMtime();
}

/**
 * Get the API key for a provider from the credential store.
 * Returns undefined if no key is stored (oauth-only entries do not count).
 */
export function getApiKey(provider: string): string | undefined {
  const creds = loadCredentials();
  const entry = creds[provider];
  if (!entry || isOAuthEntry(entry)) return undefined;
  return entry.key || undefined;
}

/**
 * Store an API key for a provider. Creates or overwrites the entry
 * (including replacing a prior oauth bundle).
 */
export function setApiKey(provider: string, key: string): void {
  runCredentialMutation((creds) => {
    // Trim paste noise (leading/trailing whitespace / newlines) that breaks auth.
    creds[provider] = { type: "api_key", key: key.trim(), savedAt: Date.now() };
  });
}

/** Store an OAuth token bundle for a provider (overwrites any prior entry). */
export function setOAuthToken(
  provider: string,
  credsBundle: {
    access: string;
    refresh: string;
    expires: number;
    type?: "oauth";
    savedAt?: number;
    [key: string]: unknown;
  },
): void {
  runCredentialMutation((creds) => {
    const access = String(credsBundle.access);
    const refresh = String(credsBundle.refresh);
    const expires = Number(credsBundle.expires);
    const entry: StoredOAuthCredential = {
      type: "oauth",
      access,
      refresh,
      expires,
      savedAt: Date.now(),
    };
    for (const [k, v] of Object.entries(credsBundle)) {
      if (
        k === "type" ||
        k === "access" ||
        k === "refresh" ||
        k === "expires" ||
        k === "savedAt"
      ) {
        continue;
      }
      entry[k] = v;
    }
    creds[provider] = entry;
  });
}

/** Get the OAuth token bundle for a provider, if present. */
export function getOAuthToken(provider: string): StoredOAuthCredential | undefined {
  const creds = loadCredentials();
  const entry = creds[provider];
  if (!entry || !isOAuthEntry(entry)) return undefined;
  return entry;
}

/** True when the provider has a stored OAuth token bundle. */
export function hasOAuthToken(provider: string): boolean {
  return getOAuthToken(provider) !== undefined;
}

/**
 * Remove a provider's credentials from the store.
 * Returns true if an entry was removed, false if none existed.
 */
export function removeCredentials(provider: string): boolean {
  return runCredentialMutation((creds) => {
    if (!(provider in creds)) return false;
    delete creds[provider];
    return true;
  });
}

/** @deprecated Alias for {@link removeCredentials}. */
export function removeApiKey(provider: string): boolean {
  return removeCredentials(provider);
}

/**
 * List all provider ids that have a stored credential (api key or oauth).
 */
export function listStoredProviders(): string[] {
  const creds = loadCredentials();
  return Object.keys(creds);
}

/**
 * Check whether a provider has a static API key in the credential store.
 */
export function hasApiKey(provider: string): boolean {
  return getApiKey(provider) !== undefined;
}

/** True when the provider has either an API key or an OAuth bundle stored. */
export function hasCredentials(provider: string): boolean {
  const creds = loadCredentials();
  return provider in creds;
}

/**
 * Resolve stored auth without environment fallback.
 * Returns null when nothing is stored.
 */
export function resolveAuth(provider: string): ResolvedAuth | null {
  const creds = loadCredentials();
  const entry = creds[provider];
  if (!entry) return null;
  if (isOAuthEntry(entry)) {
    return { kind: "oauth", apiKey: entry.access, expires: entry.expires };
  }
  return { kind: "api_key", apiKey: entry.key };
}

/**
 * Resolve the API key for a provider with fallback chain:
 *   1. Credential store (~/.praana/credentials.json) — api key or oauth access
 *   2. Environment variable (envKey, if provided)
 *   3. Keyless providers (envKey null/undefined) → `"no-key"` sentinel
 *   4. Key-requiring providers with nothing set → `""`
 *
 * Does not refresh expired OAuth tokens — call ensureFreshAccessToken from
 * the oauth facade before streaming when using OAuth providers.
 */
export function resolveApiKey(
  provider: string,
  envKey?: string | null,
  envKeyAliases?: string[] | null,
): string {
  // 1. Credential store (api key or oauth access)
  const auth = resolveAuth(provider);
  if (auth) return auth.apiKey.trim();

  // 2. Environment variable (primary + aliases)
  const keys = [
    ...(envKey ? [envKey] : []),
    ...(envKeyAliases ?? []),
  ];
  for (const name of keys) {
    const envValue = process.env[name]?.trim();
    if (envValue) return envValue;
  }
  if (keys.length > 0) {
    // Key expected but missing — empty string (do not send "no-key" as Bearer).
    return "";
  }

  // 3. Keyless providers use "no-key" sentinel
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
  credentialsMtimeMs = null;
  credentialContentReads = 0;
  storeLockDepth = 0;
  for (const lock of heldRefreshLocks.values()) lock.release();
  heldRefreshLocks.clear();
  resetCredentialLocksForTests();
}

/** @internal Lock database path for store or refresh locks. */
export function credentialLockPathForTests(kind: "store" | "refresh", provider = "openai-codex"): string {
  return kind === "store" ? credentialsLockPath() : refreshLockPath(provider);
}
