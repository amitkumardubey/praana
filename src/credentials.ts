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
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { appHomePath } from "./app-identity.js";
import { getAppLogger } from "./logger.js";

const FILE_MODE = 0o600;
/** Store-lock wait. Holders only rewrite the file synchronously, so the spin stays short. */
const STORE_LOCK_WAIT_MS = 2_000;
const REFRESH_LOCK_POLL_MS = 100;
const LOCK_STALE_MS = 60_000;
/** An empty lock is a publisher that has not finished writing. Do not treat it as dead immediately. */
const EMPTY_LOCK_GRACE_MS = 5_000;
const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const HARDLINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"]);

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
/** Test seam: runs after a lock is judged stale and before it is removed. */
let beforeStaleLockRename: ((path: string) => void) | null = null;
let linkSyncImpl: typeof linkSync = linkSync;
/** When set, lock identity checks use these values instead of the machine's. */
let identityOverride: { host: string; bootId: string | null } | null = null;
/**
 * Reentrancy for the store lock only. The counter is safe because the critical
 * section is synchronous: no other turn can run until it returns. It must never
 * stay raised across an await.
 */
let storeLockDepth = 0;
const ownedLockRaw = new Map<string, string>();

function credentialsLockPath(): string {
  return `${credentialsFilePath()}.lock`;
}

function refreshLockPath(provider: string): string {
  const safe = provider.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${credentialsFilePath()}.refresh-${safe}.lock`;
}

function sleepSync(ms: number): void {
  if (ms > 0) Bun.sleepSync(ms);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LockInfo {
  raw: string;
  pid: number;
  startedAt: number;
  host: string;
  bootId: string | null;
  mtimeMs: number;
  /** True when the file contains a published `{ pid }` object, not a partial write. */
  published: boolean;
}

function localHost(): string {
  return identityOverride?.host ?? hostname();
}

function localBootId(): string | null {
  if (identityOverride) return identityOverride.bootId;
  if (process.platform !== "linux") return null;
  try {
    const value = readFileSync(BOOT_ID_PATH, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function lockPayload(): string {
  const bootId = localBootId();
  return JSON.stringify({
    pid: process.pid,
    startedAt: Date.now(),
    host: localHost(),
    ...(bootId ? { bootId } : {}),
  });
}

/** Trust pid liveness only for a lock written on this host and boot. */
function pidIsLocal(info: LockInfo): boolean {
  if (!info.host || info.host !== localHost()) return false;
  return info.bootId === localBootId();
}

function readLockFile(path: string): LockInfo | null {
  try {
    const raw = readFileSync(path, "utf8");
    const stat = statSync(path);
    let pid = 0;
    let startedAt = 0;
    let host = "";
    let bootId: string | null = null;
    let published = false;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown; host?: unknown; bootId?: unknown };
      if (parsed && typeof parsed === "object" && typeof parsed.pid === "number" && Number.isInteger(parsed.pid)) {
        pid = parsed.pid;
        published = true;
        if (typeof parsed.startedAt === "number" && Number.isFinite(parsed.startedAt)) {
          startedAt = parsed.startedAt;
        }
        if (typeof parsed.host === "string") host = parsed.host;
        if (typeof parsed.bootId === "string" && parsed.bootId.length > 0) bootId = parsed.bootId;
      }
    } catch {
      published = false;
    }
    return { raw, pid, startedAt, host, bootId, mtimeMs: stat.mtimeMs, published };
  } catch {
    return null;
  }
}

function isStaleLock(info: LockInfo): boolean {
  const now = Date.now();
  if (!info.published) return now - info.mtimeMs > EMPTY_LOCK_GRACE_MS;
  if (pidIsLocal(info) && !isPidAlive(info.pid)) return true;
  if (now - info.mtimeMs > LOCK_STALE_MS) return true;
  if (info.startedAt > 0 && now - info.startedAt > LOCK_STALE_MS) return true;
  return false;
}

type StaleTakeover = "removed" | "absent" | "held";

/**
 * Move a stale lock aside with rename. Only one caller wins. The renamed
 * bytes must still be the lock we judged stale; otherwise put that file back.
 */
function recoverStaleLock(path: string): StaleTakeover {
  const judged = readLockFile(path);
  if (!judged || !isStaleLock(judged)) return existsSync(path) ? "held" : "absent";
  beforeStaleLockRename?.(path);
  const dest = `${path}.stale.${process.pid}.${Math.random().toString(16).slice(2)}`;
  try {
    renameSync(path, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    return existsSync(path) ? "held" : "absent";
  }
  let renamed: string;
  try {
    renamed = readFileSync(dest, "utf8");
  } catch {
    return "absent";
  }
  if (renamed !== judged.raw) {
    restoreDisplacedLock(dest, path);
    return "held";
  }
  try { unlinkSync(dest); } catch { /* the stale file is already off the lock name */ }
  return "removed";
}

/** Put a lock we renamed by mistake back on its original name. */
function restoreDisplacedLock(dest: string, path: string): void {
  if (existsSync(path)) return;
  try {
    linkSyncImpl(dest, path);
    try { unlinkSync(dest); } catch { /* path still names the inode */ }
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    try {
      if (!existsSync(path)) renameSync(dest, path);
    } catch {
      // The live lock could not be restored. Do not take it over.
    }
  }
}

/**
 * Publish a lock by linking a temp file that already holds the payload.
 * `link` fails if the lock name exists, so readers never see an empty lock
 * from this process.
 */
function publishLock(path: string): boolean {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.credlock.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  const payload = lockPayload();
  writeFileSync(tmp, payload, { encoding: "utf8", mode: FILE_MODE });
  try {
    linkSyncImpl(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code && HARDLINK_UNSUPPORTED.has(code)) return publishLockExclusive(path, payload);
    throw err;
  }
  try { unlinkSync(tmp); } catch { /* the lock path still names the inode */ }
  ownedLockRaw.set(path, payload);
  return true;
}

/** Exclusive create for filesystems that cannot hard-link. An empty file may exist until the write finishes. */
function publishLockExclusive(path: string, payload: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", FILE_MODE);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, payload);
    fsyncSync(fd);
  } catch (err) {
    try { unlinkSync(path); } catch { /* best-effort */ }
    throw err;
  } finally {
    try { closeSync(fd); } catch { /* best-effort */ }
  }
  ownedLockRaw.set(path, payload);
  return true;
}

function tryAcquirePublishedLock(path: string): boolean {
  if (publishLock(path)) return true;
  const takeover = recoverStaleLock(path);
  if (takeover === "held") return false;
  return publishLock(path);
}

function releaseLock(path: string): void {
  const raw = ownedLockRaw.get(path);
  ownedLockRaw.delete(path);
  if (raw === undefined) return;
  try {
    if (readFileSync(path, "utf8") === raw) unlinkSync(path);
  } catch {
    // The lock is already gone.
  }
}

/**
 * Store lock. Synchronous on purpose: the caller must not await while it is
 * held. Waiters spin at most 2 seconds because a holder only reads and
 * rewrites credentials.json.
 */
function acquireStoreLockSync(): void {
  const path = credentialsLockPath();
  const deadline = Date.now() + STORE_LOCK_WAIT_MS;
  let delay = 5;
  for (;;) {
    if (tryAcquirePublishedLock(path)) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the credential lock (${path}). Another PRAANA process may be updating credentials.`,
      );
    }
    sleepSync(Math.min(delay, Math.max(1, deadline - Date.now())));
    delay = Math.min(delay * 2, 40);
  }
}

function withStoreLockSync<T>(fn: () => T): T {
  if (storeLockDepth > 0) return fn();
  acquireStoreLockSync();
  storeLockDepth += 1;
  try {
    return fn();
  } finally {
    storeLockDepth -= 1;
    releaseLock(credentialsLockPath());
  }
}

/** Short critical section around a credentials.json read or rewrite. Never await inside `fn`. */
export function withCredentialStoreLockSync<T>(fn: () => T): T {
  return withStoreLockSync(fn);
}

/**
 * Per-provider refresh lock. Waiters poll asynchronously so the event loop
 * stays free while another session refreshes. Returns false when `waitMs` elapses.
 */
export async function waitForProviderRefreshLock(provider: string, waitMs: number): Promise<boolean> {
  const path = refreshLockPath(provider);
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    if (tryAcquirePublishedLock(path)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return tryAcquirePublishedLock(path);
    await Bun.sleep(Math.min(REFRESH_LOCK_POLL_MS, remaining));
  }
}

export function releaseProviderRefreshLock(provider: string): void {
  releaseLock(refreshLockPath(provider));
}

function runCredentialMutation<T>(mutator: (creds: CredentialsFile) => T): T {
  return withStoreLockSync(() => {
    const creds = readCredentialsFromDisk();
    const result = mutator(creds);
    persistCredentials(creds);
    return result;
  });
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
  beforeStaleLockRename = null;
  linkSyncImpl = linkSync;
  identityOverride = null;
}

/** @internal Injected between the staleness check and the takeover. */
export function setBeforeStaleLockRenameForTests(hook: ((path: string) => void) | null): void {
  beforeStaleLockRename = hook;
}

/** @internal Replaces `linkSync` used to publish a lock. */
export function setLockLinkSyncForTests(fn: typeof linkSync | null): void {
  linkSyncImpl = fn ?? linkSync;
}

/** @internal Host and boot id used for lock staleness. `bootId` null means none. */
export function setLockIdentityForTests(identity: { host: string; bootId: string | null } | null): void {
  identityOverride = identity;
}

function credentialLockPathForTests(kind: "store" | "refresh", provider: string): string {
  return kind === "store" ? credentialsLockPath() : refreshLockPath(provider);
}

/** @internal Acquire a store or refresh lock and leave it held. */
export function tryAcquireCredentialLockForTests(kind: "store" | "refresh", provider = "openai-codex"): boolean {
  return tryAcquirePublishedLock(credentialLockPathForTests(kind, provider));
}

/** @internal Release a lock acquired by {@link tryAcquireCredentialLockForTests}. */
export function releaseCredentialLockForTests(kind: "store" | "refresh", provider = "openai-codex"): void {
  releaseLock(credentialLockPathForTests(kind, provider));
}
