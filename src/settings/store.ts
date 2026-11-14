/**
 * Whole-document persistence and schema validation for `~/.praana/settings.json`.
 *
 * Concurrency model: cross-process advisory locking (`acquireSync` on a sibling
 * `.settings.json.lock.db` SQLite lock file, bounded wait, released in `finally`)
 * serialises every read-modify-write (`updateSettingsDocument` and
 * `replaceSettingsDocument`), combined with atomic replacement (exclusive
 * `.settings.json.tmp-<pid>-<rand>` temp file in the same directory with mode
 * 0600, fsync, close, atomic rename, and best-effort directory fsync).
 *
 * Note on permissions: mode 0600 is enforced on POSIX filesystems. On Windows,
 * POSIX mode bits do not provide equivalent ACL privacy.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { appHomePath } from "../app-identity.js";
import {
  acquireSync,
  CredentialLockTimeoutError,
  type CredentialLock,
} from "../credential-lock.js";
import { getAppLogger } from "../logger.js";
import {
  parseReasoningEffort,
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortLevel,
} from "../reasoning-levels.js";
import {
  parseConfigOverrides,
  type AcceptedOverrides,
  type RejectedOverride,
  isPlainObject,
} from "./overrides.js";

export const USER_SETTINGS_KEYS = [
  "model",
  "provider",
  "thinking",
  "incognito",
  "debug",
  "theme",
  "auto_update",
] as const;

export type UserSettingsKey = (typeof USER_SETTINGS_KEYS)[number];

export interface UserSettings {
  model: string;
  provider: string;
  thinking: boolean;
  incognito: boolean;
  debug: boolean;
  theme: string;
  auto_update: boolean;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  model: "",
  provider: "",
  thinking: true,
  incognito: false,
  debug: false,
  theme: "default",
  auto_update: false,
};

export const MAX_SETTINGS_BYTES = 1_048_576;

export interface SettingsFs {
  openExclusive: (path: string, mode: number) => number;
  write: (fd: number, data: Buffer) => void;
  fsync: (fd: number) => void;
  close: (fd: number) => void;
  rename: (oldPath: string, newPath: string) => void;
  unlink: (path: string) => void;
  copyFile: (src: string, dest: string) => void;
  chmod: (path: string, mode: number) => void;
  lstat: (path: string) => Stats;
  realpath: (path: string) => string;
  readBounded: (path: string, maxBytes: number) => Buffer;
  fsyncDir: (dirPath: string) => void;
}

export interface SettingsReadSeam {
  open?: (path: string, flags: number) => number;
  fstat?: (fd: number) => Stats;
  read?: (fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => number;
  close?: (fd: number) => void;
}

export function createSettingsFs(
  overrides: Partial<SettingsFs> = {},
  readSeam?: SettingsReadSeam,
): SettingsFs {
  const base: SettingsFs = {
    openExclusive(path: string, mode: number): number {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      return openSync(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        mode,
      );
    },
    write(fd: number, data: Buffer): void {
      let offset = 0;
      while (offset < data.byteLength) {
        const written = writeSync(fd, data, offset, data.byteLength - offset);
        if (written <= 0) throw new Error("Short write to settings temp file");
        offset += written;
      }
    },
    fsync(fd: number): void {
      fsyncSync(fd);
    },
    close(fd: number): void {
      closeSync(fd);
    },
    rename(oldPath: string, newPath: string): void {
      renameSync(oldPath, newPath);
    },
    unlink(path: string): void {
      unlinkSync(path);
    },
    copyFile(src: string, dest: string): void {
      copyFileSync(src, dest, constants.COPYFILE_EXCL);
    },
    chmod(path: string, mode: number): void {
      chmodSync(path, mode);
    },
    lstat(path: string): Stats {
      return lstatSync(path);
    },
    realpath(path: string): string {
      return realpathSync(path);
    },
    readBounded(path: string, maxBytes: number): Buffer {
      const openFn = readSeam?.open ?? openSync;
      const fstatFn = readSeam?.fstat ?? fstatSync;
      const readFn = readSeam?.read ?? readSync;
      const closeFn = readSeam?.close ?? closeSync;
      const flags =
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
      const fd = openFn(path, flags);
      try {
        const stat = fstatFn(fd);
        if (stat.isDirectory()) {
          const err = new Error(`Path is a directory: ${path}`) as NodeJS.ErrnoException;
          err.code = "EISDIR";
          throw err;
        }
        if (!stat.isFile()) {
          throw new Error(`Path is not a regular file: ${path}`);
        }
        const limit = maxBytes + 1;
        const chunks: Buffer[] = [];
        let total = 0;
        const chunkSize = Math.min(65_536, limit);
        while (total < limit) {
          const toRead = Math.min(chunkSize, limit - total);
          const buf = Buffer.allocUnsafe(toRead);
          const bytesRead = readFn(fd, buf, 0, toRead, null);
          if (bytesRead <= 0) break;
          chunks.push(bytesRead === toRead ? buf : buf.subarray(0, bytesRead));
          total += bytesRead;
        }
        const firstChunk = chunks[0];
        return chunks.length === 1 && firstChunk !== undefined ? firstChunk : Buffer.concat(chunks, total);
      } finally {
        closeFn(fd);
      }
    },
    fsyncDir(dirPath: string): void {
      let fd: number | undefined;
      try {
        fd = openSync(dirPath, constants.O_RDONLY);
        fsyncSync(fd);
      } catch {
        // Best-effort directory fsync; ignored on platforms/filesystems that reject it.
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd);
          } catch {
            // ignore close error
          }
        }
      }
    },
  };

  return {
    openExclusive: overrides.openExclusive ?? base.openExclusive,
    write: overrides.write ?? base.write,
    fsync: overrides.fsync ?? base.fsync,
    close: overrides.close ?? base.close,
    rename: overrides.rename ?? base.rename,
    unlink: overrides.unlink ?? base.unlink,
    copyFile: overrides.copyFile ?? base.copyFile,
    chmod: overrides.chmod ?? base.chmod,
    lstat: overrides.lstat ?? base.lstat,
    realpath: overrides.realpath ?? base.realpath,
    readBounded: overrides.readBounded ?? base.readBounded,
    fsyncDir: overrides.fsyncDir ?? base.fsyncDir,
  };
}

const defaultFs = createSettingsFs();

export type SettingsReadState = "missing" | "ok" | "corrupt" | "unreadable";

export interface SettingsStoreOptions {
  path?: string;
  fs?: SettingsFs;
}

export type ReadSettingsDocumentResult =
  | { doc: Record<string, unknown>; state: "missing"; error?: undefined }
  | { doc: Record<string, unknown>; state: "ok"; error?: undefined }
  | { doc: Record<string, unknown>; state: "corrupt"; error: string }
  | { doc: Record<string, unknown>; state: "unreadable"; error: string };

/** Default location of the settings document. */
export function settingsFilePath(): string {
  return appHomePath("settings.json");
}

function resolveSettingsPath(options?: SettingsStoreOptions): string {
  return options?.path ?? settingsFilePath();
}

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });

function symlinkResolutionError(
  path: string,
  err: unknown,
  fallbackPrefix: string,
): ReadSettingsDocumentResult {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    return {
      doc: {},
      state: "unreadable",
      error: `Settings file symlink (${path}) points to a missing target; create the target file or remove the symlink`,
    };
  }
  if (code === "ELOOP") {
    return {
      doc: {},
      state: "unreadable",
      error: `Settings file symlink (${path}) forms a symlink loop; fix or remove the symlink`,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return {
    doc: {},
    state: "unreadable",
    error: `${fallbackPrefix} (${path}): ${msg}`,
  };
}

function resolveSettingsTarget(
  path: string,
  fs: SettingsFs,
):
  | { ok: true; targetPath: string; isSymlink: boolean }
  | { ok: false; result: ReadSettingsDocumentResult; targetPath: string } {
  let stat: Stats;
  try {
    stat = fs.lstat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { ok: false, result: { doc: {}, state: "missing" }, targetPath: path };
    }
    if (code === "ELOOP") {
      return {
        ok: false,
        result: symlinkResolutionError(path, err, "Cannot stat settings file"),
        targetPath: path,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      result: { doc: {}, state: "unreadable", error: `Cannot stat settings file (${path}): ${msg}` },
      targetPath: path,
    };
  }

  if (!stat.isSymbolicLink()) {
    if (stat.isDirectory()) {
      return {
        ok: false,
        result: { doc: {}, state: "unreadable", error: `Settings path is a directory (${path})` },
        targetPath: path,
      };
    }
    if (!stat.isFile()) {
      return {
        ok: false,
        result: { doc: {}, state: "unreadable", error: `Settings path is not a regular file (${path})` },
        targetPath: path,
      };
    }
    return { ok: true, targetPath: path, isSymlink: false };
  }

  let targetPath: string;
  try {
    targetPath = fs.realpath(path);
  } catch (err) {
    return {
      ok: false,
      result: symlinkResolutionError(path, err, "Cannot resolve settings file symlink"),
      targetPath: path,
    };
  }

  let targetStat: Stats;
  try {
    targetStat = fs.lstat(targetPath);
  } catch (err) {
    return {
      ok: false,
      result: symlinkResolutionError(path, err, "Cannot stat target of settings file symlink"),
      targetPath,
    };
  }

  if (targetStat.isDirectory()) {
    return {
      ok: false,
      result: {
        doc: {},
        state: "unreadable",
        error: `Settings file symlink (${path}) points to a directory; point it to a regular file or remove the symlink`,
      },
      targetPath,
    };
  }
  if (!targetStat.isFile()) {
    return {
      ok: false,
      result: {
        doc: {},
        state: "unreadable",
        error: `Settings file symlink (${path}) does not point to a regular file; point it to a regular file or remove the symlink`,
      },
      targetPath,
    };
  }

  return { ok: true, targetPath, isSymlink: true };
}

function readSettingsDocumentWithBytes(
  path: string,
  fs: SettingsFs,
): { result: ReadSettingsDocumentResult; rawBytes?: Buffer; targetPath: string } {
  const resolved = resolveSettingsTarget(path, fs);
  if (!resolved.ok) {
    return { result: resolved.result, targetPath: resolved.targetPath };
  }
  const { targetPath, isSymlink } = resolved;

  let rawBytes: Buffer;
  try {
    rawBytes = fs.readBounded(targetPath, MAX_SETTINGS_BYTES);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      if (isSymlink) {
        return {
          result: {
            doc: {},
            state: "unreadable",
            error: `Settings file symlink (${path}) points to a missing target; create the target file or remove the symlink`,
          },
          targetPath,
        };
      }
      return { result: { doc: {}, state: "missing" }, targetPath };
    }
    if (code === "ELOOP") {
      return {
        result: {
          doc: {},
          state: "unreadable",
          error: isSymlink
            ? `Settings file symlink (${path}) forms a symlink loop; fix or remove the symlink`
            : `Settings path (${path}) changed to a symlink; retry or replace it`,
        },
        targetPath,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (isSymlink && (code === "EISDIR" || msg.includes("Path is a directory"))) {
      return {
        result: {
          doc: {},
          state: "unreadable",
          error: `Settings file symlink (${path}) points to a directory; point it to a regular file or remove the symlink`,
        },
        targetPath,
      };
    }
    if (isSymlink && msg.includes("Path is not a regular file")) {
      return {
        result: {
          doc: {},
          state: "unreadable",
          error: `Settings file symlink (${path}) does not point to a regular file; point it to a regular file or remove the symlink`,
        },
        targetPath,
      };
    }
    return {
      result: { doc: {}, state: "unreadable", error: `Cannot read settings file (${path}): ${msg}` },
      targetPath,
    };
  }

  if (rawBytes.byteLength > MAX_SETTINGS_BYTES) {
    return {
      result: {
        doc: {},
        state: "unreadable",
        error: `Settings file (${path}) exceeds maximum size of ${MAX_SETTINGS_BYTES} bytes`,
      },
      targetPath,
    };
  }

  let decoded: string;
  try {
    decoded = UTF8_FATAL.decode(rawBytes);
  } catch {
    return {
      result: { doc: {}, state: "corrupt", error: `Settings file (${path}) is not valid UTF-8` },
      rawBytes,
      targetPath,
    };
  }

  const text = decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      result: { doc: {}, state: "corrupt", error: `Corrupt settings file (${path})` },
      rawBytes,
      targetPath,
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      result: {
        doc: {},
        state: "corrupt",
        error: `Corrupt settings file (${path}): root must be a JSON object`,
      },
      rawBytes,
      targetPath,
    };
  }

  return { result: { doc: parsed, state: "ok" }, rawBytes, targetPath };
}

export function readSettingsDocument(options?: SettingsStoreOptions): ReadSettingsDocumentResult {
  const path = resolveSettingsPath(options);
  const fs = options?.fs ?? defaultFs;
  return readSettingsDocumentWithBytes(path, fs).result;
}

function writeExclusiveFile(
  filePath: string,
  bytes: Buffer,
  fs: SettingsFs,
  afterClose?: () => void,
): { ok: true } | { ok: false; error: string } {
  let fd: number;
  try {
    fd = fs.openExclusive(filePath, 0o600);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let closed = false;
  try {
    fs.write(fd, bytes);
    fs.fsync(fd);
    closed = true;
    fs.close(fd);
    try {
      fs.chmod(filePath, 0o600);
    } catch {
      // Ignore chmod failure on platforms without POSIX mode semantics.
    }
    afterClose?.();
    return { ok: true };
  } catch (err) {
    if (!closed) {
      closed = true;
      try {
        fs.close(fd);
      } catch {
        // best-effort close
      }
    }
    try {
      fs.unlink(filePath);
    } catch {
      // best-effort temp cleanup
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function logBestEffortFailure(
  operation: string,
  message: string,
  details: Record<string, unknown>,
  cause: unknown,
): void {
  try {
    const msg = cause instanceof Error ? cause.message : String(cause);
    getAppLogger()
      .child("config")
      .warn(`${message}: ${msg}`, {
        details: { ...details, operation },
        cause: cause instanceof Error ? cause : undefined,
      });
  } catch {
    // Best-effort logging must never mask the primary operation result.
  }
}

function writeDocumentAtomic(
  path: string,
  doc: Record<string, unknown>,
  fs: SettingsFs,
): { ok: true } | { ok: false; error: string } {
  // Caller-supplied input is validated before it reaches the merge (`updateSettingsDocument`
  // patch/base and `replaceSettingsDocument` input). The merged document is not re-scanned:
  // keys that came from disk are own properties produced by `JSON.parse`, so they cannot
  // pollute prototypes, and re-scanning them would make an otherwise valid file impossible
  // to update or reset. Only the serialized size limit applies here.
  let serialized: string;
  try {
    serialized = JSON.stringify(doc, null, 2) + "\n";
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const bytes = Buffer.from(serialized, "utf8");
  if (bytes.byteLength > MAX_SETTINGS_BYTES) {
    return {
      ok: false,
      error: `Serialized settings document (${bytes.byteLength} bytes) exceeds maximum size of ${MAX_SETTINGS_BYTES} bytes`,
    };
  }

  const dir = dirname(path);
  const base = basename(path);
  const tmpPath = join(dir, `.${base}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);

  return writeExclusiveFile(tmpPath, bytes, fs, () => {
    // The renamed inode is the 0600 temp file, so no second chmod is needed.
    fs.rename(tmpPath, path);
    try {
      // Best effort: the rename has already committed, so a directory fsync failure must
      // not report the write as failed.
      fs.fsyncDir(dir);
    } catch (err) {
      // Ignore: durability of the directory entry is not something the caller can act on.
      logBestEffortFailure(
        "fsyncSettingsDir",
        `Failed to fsync settings directory (${dir}) for ${path}`,
        { path, dir },
        err,
      );
    }
  });
}

const SETTINGS_LOCK_WAIT_MS = 2_000;

function settingsLockPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.lock.db`);
}

function withSettingsLock<T>(
  path: string,
  fn: () => T | { ok: false; error: string },
): T | { ok: false; error: string } {
  const lockPath = settingsLockPath(path);
  let lock: CredentialLock;
  try {
    lock = acquireSync(lockPath, { waitMs: SETTINGS_LOCK_WAIT_MS });
  } catch (err) {
    if (err instanceof CredentialLockTimeoutError) {
      return {
        ok: false,
        error: `Timed out waiting for settings lock (${lockPath}). Another process may be updating settings.`,
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    return fn();
  } finally {
    try {
      lock.release();
    } catch (err) {
      // Best effort: a release failure must not replace a committed result with an exception.
      logBestEffortFailure(
        "releaseSettingsLock",
        `Failed to release settings lock (${lockPath})`,
        { path: lockPath, settingsPath: path },
        err,
      );
    }
  }
}

const FORBIDDEN_DOC_KEYS = ["__proto__", "constructor", "prototype"] as const;
const MAX_SETTINGS_DEPTH = 32;
const MAX_SCAN_NODES = 100_000;

function scanSettingsValue(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
  state = { nodes: 0 },
): { forbiddenKey?: string; error?: string } {
  if (typeof value !== "object" || value === null) return {};
  if (depth > MAX_SETTINGS_DEPTH) {
    return { error: `Settings object exceeds maximum nesting depth of ${MAX_SETTINGS_DEPTH}` };
  }
  if (ancestors.has(value)) {
    return { error: "Settings object contains a circular reference" };
  }
  if (++state.nodes > MAX_SCAN_NODES) {
    return { error: "Settings object exceeds maximum node count" };
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const res = scanSettingsValue(value[i], ancestors, depth + 1, state);
        if (res.forbiddenKey || res.error) return res;
      }
      return {};
    }
    if (!isPlainObject(value)) {
      return { error: "Nested settings values must be plain objects or arrays" };
    }
    for (const key of FORBIDDEN_DOC_KEYS) {
      if (Object.hasOwn(value, key)) {
        return { forbiddenKey: key };
      }
    }
    if (Object.hasOwn(value, "toJSON") && typeof (value as { toJSON?: unknown }).toJSON === "function") {
      return { error: 'Forbidden settings method "toJSON"' };
    }
    for (const key of Object.keys(value)) {
      const res = scanSettingsValue((value as Record<string, unknown>)[key], ancestors, depth + 1, state);
      if (res.forbiddenKey || res.error) return res;
    }
    return {};
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    ancestors.delete(value);
  }
}

function validateSettingsObject(obj: unknown, label: string): string | undefined {
  try {
    if (!isPlainObject(obj)) {
      return `${label} must be a plain object`;
    }
    const scan = scanSettingsValue(obj);
    if (scan.error) {
      return `${label}: ${scan.error}`;
    }
    if (scan.forbiddenKey) {
      return `Forbidden settings key "${scan.forbiddenKey}"`;
    }
    return undefined;
  } catch (err) {
    return `${label} could not be validated: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export interface UpdateSettingsDocumentOptions extends SettingsStoreOptions {
  baseDefaultsIfMissing?: Record<string, unknown>;
  createOnly?: boolean;
  onCorrupt?: "error" | "backup-and-reset-legacy";
}

export type UpdateSettingsDocumentResult =
  | { ok: true; doc: Record<string, unknown>; created: boolean; backupPath?: string }
  | { ok: false; error: string; state?: SettingsReadState };

export function updateSettingsDocument(
  patch: Record<string, unknown>,
  options?: UpdateSettingsDocumentOptions,
): UpdateSettingsDocumentResult {
  const patchErr = validateSettingsObject(patch, "Settings patch");
  if (patchErr) return { ok: false, error: patchErr };
  if (options?.baseDefaultsIfMissing !== undefined) {
    const baseErr = validateSettingsObject(options.baseDefaultsIfMissing, "Settings base defaults");
    if (baseErr) return { ok: false, error: baseErr };
  }

  const path = resolveSettingsPath(options);
  const fs = options?.fs ?? defaultFs;
  return withSettingsLock<UpdateSettingsDocumentResult>(path, () => {
    const { result: current, rawBytes, targetPath } = readSettingsDocumentWithBytes(path, fs);

    if (current.state === "unreadable") {
      return {
        ok: false,
        error: current.error,
        state: current.state,
      };
    }

    // `createOnly` must never modify an existing file, whatever its state: no write, no backup.
    if (options?.createOnly && current.state !== "missing") {
      if (current.state === "ok") {
        return { ok: true, doc: { ...current.doc }, created: false };
      }
      return {
        ok: false,
        error: current.error,
        state: current.state,
      };
    }

    let backupPath: string | undefined;
    if (current.state === "corrupt") {
      if (options?.onCorrupt !== "backup-and-reset-legacy") {
        return {
          ok: false,
          error: current.error,
          state: current.state,
        };
      }
      const backedUp = backupCorruptFile(path, rawBytes, fs, targetPath);
      if (!backedUp.ok) return backedUp;
      backupPath = backedUp.backupPath;
    }

    if (current.state === "ok") {
      const hasPatchChanges = Object.keys(patch).some((key) => patch[key] !== undefined);
      if (!hasPatchChanges) {
        return { ok: true, doc: { ...current.doc }, created: false };
      }
    }

    const nextDoc: Record<string, unknown> =
      (current.state === "missing" || current.state === "corrupt") && options?.baseDefaultsIfMissing
        ? { ...options.baseDefaultsIfMissing }
        : current.state === "ok"
          ? { ...current.doc }
          : {};

    for (const key of Object.keys(patch)) {
      const val = patch[key];
      if (val === null) {
        delete nextDoc[key];
      } else if (val !== undefined) {
        Object.defineProperty(nextDoc, key, {
          value: val,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }

    const written = writeDocumentAtomic(targetPath, nextDoc, fs);
    if (!written.ok) {
      if (backupPath) discardCorruptBackup(backupPath, fs);
      return written;
    }
    return {
      ok: true,
      doc: nextDoc,
      created: current.state === "missing",
      ...(backupPath ? { backupPath } : {}),
    };
  });
}

function writeCorruptBackup(
  path: string,
  backupPath: string,
  bytes: Buffer,
  fs: SettingsFs,
): { ok: true } | { ok: false; error: string } {
  const res = writeExclusiveFile(backupPath, bytes, fs);
  if (!res.ok) {
    return { ok: false, error: `Failed to back up corrupt settings file (${path}): ${res.error}` };
  }
  return res;
}

function backupCorruptFile(
  path: string,
  rawBytes: Buffer | undefined,
  fs: SettingsFs,
  targetPath: string = path,
): { ok: true; backupPath: string } | { ok: false; error: string } {
  const backupPath = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
  let backupBytes: Buffer;
  try {
    backupBytes = rawBytes ?? fs.readBounded(targetPath, MAX_SETTINGS_BYTES);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to back up corrupt settings file (${path}): ${msg}` };
  }
  const backedUp = writeCorruptBackup(path, backupPath, backupBytes, fs);
  if (!backedUp.ok) return backedUp;
  return { ok: true, backupPath };
}

/**
 * Undo a backup whose replacement write failed, so repeated failed attempts cannot
 * pile up `corrupt-*` files. Best effort: a backup that cannot be removed is only
 * extra noise next to the corrupt file the caller is already told about.
 */
function discardCorruptBackup(backupPath: string, fs: SettingsFs): void {
  try {
    fs.unlink(backupPath);
  } catch (err) {
    // Ignore: the write error is the result the caller needs.
    logBestEffortFailure(
      "discardCorruptBackup",
      `Failed to remove discarded corrupt settings backup (${backupPath})`,
      { path: backupPath },
      err,
    );
  }
}

export function replaceSettingsDocument(
  doc: Record<string, unknown>,
  options?: SettingsStoreOptions & { backupCorrupt?: boolean },
): { ok: true; doc: Record<string, unknown>; backupPath?: string } | { ok: false; error: string } {
  const docErr = validateSettingsObject(doc, "Settings document");
  if (docErr) return { ok: false, error: docErr };

  const path = resolveSettingsPath(options);
  const fs = options?.fs ?? defaultFs;
  return withSettingsLock(path, () => {
    const { result: current, rawBytes, targetPath } = readSettingsDocumentWithBytes(path, fs);

    if (current.state === "unreadable") {
      return {
        ok: false,
        error: current.error,
      };
    }

    let backupPath: string | undefined;
    if (current.state === "corrupt" && options?.backupCorrupt !== false) {
      const backedUp = backupCorruptFile(path, rawBytes, fs, targetPath);
      if (!backedUp.ok) return backedUp;
      backupPath = backedUp.backupPath;
    }

    const copy = { ...doc };
    const written = writeDocumentAtomic(targetPath, copy, fs);
    if (!written.ok) {
      if (backupPath) discardCorruptBackup(backupPath, fs);
      return written;
    }
    return { ok: true, doc: copy, ...(backupPath ? { backupPath } : {}) };
  });
}

export const REASONING_LEVELS = REASONING_EFFORT_LEVELS;
export type ReasoningLevel = ReasoningEffortLevel;

export interface DefaultModel {
  provider: string;
  model: string;
  reasoning?: ReasoningLevel;
}

export interface InvalidKeyEntry {
  key: string;
  reason: string;
}

export function parseDefaultModel(raw: unknown): {
  value: DefaultModel | null;
  errors: InvalidKeyEntry[];
} {
  if (raw === undefined) return { value: null, errors: [] };
  if (!isPlainObject(raw)) {
    return {
      value: null,
      errors: [{ key: "default_model", reason: "default_model must be a plain object" }],
    };
  }

  const errors: InvalidKeyEntry[] = [];
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  if (!provider) {
    errors.push({ key: "default_model.provider", reason: "provider must be a non-empty string" });
  }

  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model) {
    errors.push({ key: "default_model.model", reason: "model must be a non-empty string" });
  }

  let reasoning: ReasoningLevel | undefined;
  if (raw.reasoning !== undefined) {
    const parsedReasoning = typeof raw.reasoning === "string" ? parseReasoningEffort(raw.reasoning) : null;
    if (parsedReasoning !== null) {
      reasoning = parsedReasoning;
    } else {
      errors.push({
        key: "default_model.reasoning",
        reason: `reasoning must be one of: ${REASONING_LEVELS.join(", ")}`,
      });
    }
  }

  for (const key of Object.keys(raw)) {
    if (key !== "provider" && key !== "model" && key !== "reasoning") {
      errors.push({ key: `default_model.${key}`, reason: `Unknown field "${key}" in default_model` });
    }
  }

  if (errors.length > 0) {
    return { value: null, errors };
  }

  return {
    value: {
      provider,
      model,
      ...(reasoning !== undefined ? { reasoning } : {}),
    },
    errors: [],
  };
}

/** Accepts true/false, on/off, 1/0 (strings case-insensitive and trimmed) and the numbers 1/0. */
export function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "on" || v === "1") return true;
    if (v === "false" || v === "off" || v === "0") return false;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return undefined;
}

/**
 * Validate the seven legacy keys of a settings document. Unknown keys are
 * ignored; each invalid known key is reported with a reason and keeps its default.
 */
export function normalizeLegacySettings(
  doc: Record<string, unknown>,
): { settings: UserSettings; invalidKeys: InvalidKeyEntry[] } {
  const settings: UserSettings = { ...DEFAULT_USER_SETTINGS };
  const invalidKeys: InvalidKeyEntry[] = [];
  for (const key of USER_SETTINGS_KEYS) {
    const rawVal = doc[key];
    if (rawVal === undefined) continue;
    if (key === "thinking" || key === "incognito" || key === "debug" || key === "auto_update") {
      const b = coerceBoolean(rawVal);
      if (b === undefined) {
        invalidKeys.push({ key, reason: `Invalid boolean value for ${key}` });
      } else {
        settings[key] = b;
      }
    } else if (key === "theme") {
      if (typeof rawVal !== "string" || rawVal.trim().length === 0) {
        invalidKeys.push({ key, reason: "theme must be a non-empty string" });
      } else {
        settings.theme = rawVal.trim();
      }
    } else {
      const k = key as Extract<UserSettingsKey, "model" | "provider">;
      if (typeof rawVal !== "string") {
        invalidKeys.push({ key: k, reason: `${k} must be a string` });
      } else {
        settings[k] = rawVal.trim();
      }
    }
  }

  return { settings, invalidKeys };
}

export interface LoadSettingsFileResult {
  settings: UserSettings;
  defaultModel: DefaultModel | null;
  configOverrides: AcceptedOverrides;
  invalidKeys: InvalidKeyEntry[];
  ignoredUnknownKeys: string[];
  rejectedOverrides: RejectedOverride[];
  state: SettingsReadState;
  warnings: string[];
}

const KNOWN_TOP_LEVEL_KEYS = new Set<string>([
  ...USER_SETTINGS_KEYS,
  "default_model",
  "config_overrides",
]);

export function loadSettingsFile(options?: SettingsStoreOptions): LoadSettingsFileResult {
  const read = readSettingsDocument(options);
  const settings: UserSettings = { ...DEFAULT_USER_SETTINGS };

  if (read.state !== "ok") {
    return {
      settings,
      defaultModel: null,
      configOverrides: {},
      invalidKeys: [],
      ignoredUnknownKeys: [],
      rejectedOverrides: [],
      state: read.state,
      warnings: read.error ? [read.error] : [],
    };
  }

  const doc = read.doc;
  const invalidKeys: InvalidKeyEntry[] = [];
  const ignoredUnknownKeys: string[] = [];
  const warnings: string[] = [];

  const legacy = normalizeLegacySettings(doc);
  const settingsFromDoc = legacy.settings;
  invalidKeys.push(...legacy.invalidKeys);

  const dm = parseDefaultModel(doc.default_model);
  invalidKeys.push(...dm.errors);

  const { accepted: configOverrides, rejected: rejectedOverrides } = parseConfigOverrides(doc.config_overrides);
  // A malformed `config_overrides` is also an invalid top-level key; it is warned about once, below.
  for (const rej of rejectedOverrides) {
    if (rej.path === "config_overrides") invalidKeys.push({ key: "config_overrides", reason: rej.reason });
  }

  for (const key of Object.keys(doc)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      ignoredUnknownKeys.push(key);
    }
  }

  for (const inv of invalidKeys) {
    warnings.push(`Invalid setting "${inv.key}": ${inv.reason}`);
  }
  for (const rej of rejectedOverrides) {
    if (rej.path === "config_overrides") continue;
    warnings.push(`Rejected config override "${rej.path}": ${rej.reason}`);
  }

  return {
    settings: settingsFromDoc,
    defaultModel: dm.value,
    configOverrides,
    invalidKeys,
    ignoredUnknownKeys,
    rejectedOverrides,
    state: "ok",
    warnings,
  };
}
