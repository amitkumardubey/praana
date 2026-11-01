// Operating-system advisory locks for the credential store.
//
// A lock is a tiny SQLite database. `BEGIN IMMEDIATE` takes the database's
// reserved lock, which SQLite implements with the OS file lock (fcntl on Linux,
// LockFileEx on Windows). That lock is dropped when the connection closes and
// when the process dies, including SIGKILL. There is no stale-lock recovery:
// no pid, host, boot id, age rule, rename, or hard link.
//
// One process keeps at most one connection per lock path. A second connection
// in the same process can drop the first connection's OS lock on close, so
// async waiters queue in memory and a sync waiter does not open another
// connection while this process already holds the path.

import { chmodSync, closeSync, mkdirSync, openSync, readSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const MAX_SYNC_WAIT_MS = 2_000;
const MAX_ASYNC_WAIT_MS = 30_000;
const MIN_POLL_MS = 100;
const MAX_POLL_MS = 250;
/** A brand-new lock file can report this briefly. A corrupt file does not get the whole wait. */
const NOTADB_ATTEMPTS = 3;

export class CredentialLockTimeoutError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `Timed out waiting for the credential lock (${path}). Another PRAANA process may be updating credentials.`,
    );
    this.name = "CredentialLockTimeoutError";
    this.path = path;
  }
}

export interface CredentialLock {
  /** Idempotent. Safe to call from `finally`. */
  release(): void;
}

export interface AcquireSyncOptions {
  /** Capped at 2 seconds. Applied as SQLite `busy_timeout` for another process. */
  waitMs: number;
}

export interface AcquireAsyncOptions {
  /** Capped at 30 seconds. */
  waitMs: number;
  /** Ends the wait only. A lock already held is not released. */
  signal?: AbortSignal;
  /** Clamped to 100–250 ms. */
  pollMs?: number;
}

interface LockSlot {
  held: boolean;
  waiters: Array<{
    grant: () => void;
    reject: (err: Error) => void;
  }>;
}

const openLocks = new Set<Database>();
const held = new Map<string, Database>();
const slots = new Map<string, LockSlot>();

function sleepSync(ms: number): void {
  if (ms > 0) Bun.sleepSync(ms);
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    if (reason.name === "AbortError") return reason;
    const err = new Error(reason.message);
    err.name = "AbortError";
    return err;
  }
  const err = new Error(typeof reason === "string" && reason ? reason : "The operation was aborted.");
  err.name = "AbortError";
  return err;
}

function sqliteCode(err: unknown): string {
  if (!err || typeof err !== "object") return "";
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/** Another connection holds the database. A file that is not a database is handled separately. */
function isRetryableLockError(err: unknown): boolean {
  const code = sqliteCode(err);
  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_BUSY_RECOVERY" ||
    code === "SQLITE_BUSY_SNAPSHOT" ||
    code === "SQLITE_LOCKED"
  ) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY/i.test(message);
}

function isNotADatabase(err: unknown): boolean {
  if (sqliteCode(err) === "SQLITE_NOTADB") return true;
  const message = err instanceof Error ? err.message : String(err);
  return /not a database/i.test(message);
}

function corruptLockError(path: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  const error = new Error(
    `Credential lock database is corrupt and could not be recovered (${path}): ${detail}`,
  );
  error.name = "CredentialLockCorruptError";
  (error as Error & { cause?: unknown }).cause = cause;
  return error;
}

interface LockFileIdentity {
  dev: number;
  ino: number;
}

function lockFileIdentity(path: string): LockFileIdentity | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

function sameLockFile(left: LockFileIdentity | undefined, right: LockFileIdentity | undefined): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

/**
 * A non-database file can be deleted once, and only if it is still the file
 * that failed to open. An empty file is a valid SQLite database being created.
 */
function lockFileIsReplaceable(path: string, seen: LockFileIdentity | undefined): boolean {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    if (seen && (stat.dev !== seen.dev || stat.ino !== seen.ino)) return false;
    if (stat.size === 0) return false;
    fd = openSync(path, "r");
    const header = Buffer.alloc(16);
    const n = readSync(fd, header, 0, 16, 0);
    return !header.subarray(0, n).toString("utf8").startsWith("SQLite format 3");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/** @internal */
export function lockFileIsReplaceableForTests(path: string, seen?: LockFileIdentity): boolean {
  return lockFileIsReplaceable(path, seen);
}

interface NotADatabaseState {
  streak: number;
  recreated: boolean;
}

/**
 * Retry a few times for a file another process is still creating.
 * Then delete a non-database file once, if it is still the same file, and try again.
 * A further failure, or a file we cannot replace, throws.
 */
function recoverNotADatabase(
  path: string,
  err: unknown,
  state: NotADatabaseState,
  seen: LockFileIdentity | undefined,
): void {
  state.streak += 1;
  if (state.streak <= NOTADB_ATTEMPTS) return;
  const current = lockFileIdentity(path);
  if (seen && current && !sameLockFile(seen, current)) {
    state.streak = 0;
    return;
  }
  if (!state.recreated && lockFileIsReplaceable(path, seen) && sameLockFile(seen, lockFileIdentity(path))) {
    state.recreated = true;
    state.streak = 0;
    try {
      unlinkSync(path);
    } catch (unlinkErr) {
      throw corruptLockError(path, unlinkErr);
    }
    return;
  }
  throw corruptLockError(path, err);
}

function isContention(err: unknown): boolean {
  const code = sqliteCode(err);
  if (code === "SQLITE_NOTADB") return false;
  return isRetryableLockError(err);
}

function slotFor(path: string): LockSlot {
  let slot = slots.get(path);
  if (!slot) {
    slot = { held: false, waiters: [] };
    slots.set(path, slot);
  }
  return slot;
}

/**
 * In-process queue. The next async acquire does not open a connection until
 * the previous async holder has released.
 */
function acquireSlot(path: string, signal: AbortSignal | undefined, deadline: number): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const slot = slotFor(path);
  const release = () => {
    const next = slot.waiters.shift();
    if (next) next.grant();
    else slot.held = false;
  };
  if (!slot.held) {
    slot.held = true;
    return Promise.resolve(release);
  }
  if (Date.now() >= deadline) return Promise.reject(new CredentialLockTimeoutError(path));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const waiter = {
      grant: () => finish(() => resolve(release)),
      reject: (err: Error) => finish(() => reject(err)),
    };
    const onAbort = () => {
      const index = slot.waiters.indexOf(waiter);
      if (index >= 0) slot.waiters.splice(index, 1);
      waiter.reject(abortError(signal!));
    };
    const onTimeout = () => {
      const index = slot.waiters.indexOf(waiter);
      if (index >= 0) slot.waiters.splice(index, 1);
      waiter.reject(new CredentialLockTimeoutError(path));
    };
    timer = setTimeout(onTimeout, Math.max(1, deadline - Date.now()));
    slot.waiters.push(waiter);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal!));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Open the lock database and take `BEGIN IMMEDIATE`.
 * The schema is committed before the lock transaction so another process sees
 * a real database and gets SQLITE_BUSY rather than SQLITE_NOTADB.
 * On failure the connection is closed.
 */
function beginImmediate(path: string, busyMs: number): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  try {
    try { chmodSync(path, 0o600); } catch { /* best-effort; Windows may reject the mode */ }
    const timeout = Math.max(0, Math.trunc(busyMs));
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec("CREATE TABLE IF NOT EXISTS credential_lock (id INTEGER PRIMARY KEY)");
    db.exec("BEGIN IMMEDIATE");
    openLocks.add(db);
    return db;
  } catch (err) {
    try { db.close(); } catch { /* the failed attempt must not leak a connection */ }
    throw err;
  }
}

function releaseDatabase(path: string, db: Database): void {
  if (!openLocks.has(db)) return;
  openLocks.delete(db);
  try { db.exec("ROLLBACK"); } catch { /* the transaction is already closed */ }
  try { db.close(); } catch { /* already closed */ }
  // Clear the in-process hold only after close, so a waiter does not open a
  // second connection while this one still has the file.
  if (held.get(path) === db) held.delete(path);
}

function hold(path: string, db: Database): CredentialLock {
  held.set(path, db);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      releaseDatabase(path, db);
    },
  };
}

function pollMsOf(pollMs: number | undefined): number {
  const value = pollMs ?? MIN_POLL_MS;
  if (!Number.isFinite(value)) return MIN_POLL_MS;
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.trunc(value)));
}

/** Short synchronous lock. Blocks the caller for at most 2 seconds. */
export function acquireSync(path: string, opts: AcquireSyncOptions): CredentialLock {
  const waitMs = Math.min(MAX_SYNC_WAIT_MS, Math.max(0, Math.trunc(opts.waitMs) || 0));
  const deadline = Date.now() + waitMs;
  const notadb: NotADatabaseState = { streak: 0, recreated: false };
  for (;;) {
    if (held.has(path)) {
      if (Date.now() >= deadline) throw new CredentialLockTimeoutError(path);
      sleepSync(Math.min(20, Math.max(1, deadline - Date.now())));
      continue;
    }
    const remaining = Math.max(0, deadline - Date.now());
    const seen = lockFileIdentity(path);
    try {
      return hold(path, beginImmediate(path, remaining));
    } catch (err) {
      if (isNotADatabase(err)) {
        recoverNotADatabase(path, err, notadb, seen);
        sleepSync(20);
        continue;
      }
      if (!isRetryableLockError(err)) throw err;
      // busy_timeout already waited out a real SQLITE_BUSY.
      if (isContention(err) || Date.now() >= deadline) throw new CredentialLockTimeoutError(path);
      sleepSync(Math.min(20, Math.max(1, deadline - Date.now())));
    }
  }
}

async function acquireFromOs(path: string, opts: AcquireAsyncOptions): Promise<CredentialLock> {
  const waitMs = Math.min(MAX_ASYNC_WAIT_MS, Math.max(0, Math.trunc(opts.waitMs) || 0));
  const pollMs = pollMsOf(opts.pollMs);
  const deadline = Date.now() + waitMs;
  const notadb: NotADatabaseState = { streak: 0, recreated: false };
  for (;;) {
    if (opts.signal?.aborted) throw abortError(opts.signal);
    if (!held.has(path)) {
      const seen = lockFileIdentity(path);
      try {
        return hold(path, beginImmediate(path, 0));
      } catch (err) {
        if (isNotADatabase(err)) {
          recoverNotADatabase(path, err, notadb, seen);
        } else if (!isRetryableLockError(err)) {
          throw err;
        }
      }
    }
    if (Date.now() >= deadline) throw new CredentialLockTimeoutError(path);
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), opts.signal);
  }
}

/**
 * Async lock. `busy_timeout` is 0 so a busy database returns immediately and
 * the wait sleeps without blocking the event loop.
 */
export async function acquireAsync(path: string, opts: AcquireAsyncOptions): Promise<CredentialLock> {
  const waitMs = Math.min(MAX_ASYNC_WAIT_MS, Math.max(0, Math.trunc(opts.waitMs) || 0));
  const deadline = Date.now() + waitMs;
  const releaseSlot = await acquireSlot(path, opts.signal, deadline);
  try {
    const lock = await acquireFromOs(path, { ...opts, waitMs: Math.max(0, deadline - Date.now()) });
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        try {
          lock.release();
        } finally {
          releaseSlot();
        }
      },
    };
  } catch (err) {
    releaseSlot();
    throw err;
  }
}

/** @internal Drop every lock this process holds. Test isolation only. */
export function resetCredentialLocksForTests(): void {
  for (const [path, db] of [...held.entries()]) releaseDatabase(path, db);
  for (const slot of slots.values()) {
    slot.held = false;
    const waiters = slot.waiters.splice(0);
    for (const waiter of waiters) {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      waiter.reject(err);
    }
  }
  slots.clear();
}
