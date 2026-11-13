/**
 * Whole-document persistence and schema validation for `~/.praana/settings.json`.
 *
 * Concurrency model: atomic replacement (exclusive `.settings.json.tmp-<pid>-<rand>`
 * temp file in the same directory with mode 0600, fsync, close, atomic rename,
 * and best-effort directory fsync) combined with re-read-before-write key merge.
 * Two processes writing at the exact same instant can still lose one update
 * (last-writer-wins at the rename point), which is accepted; a torn or partially
 * written settings file is never possible.
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
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { appHomePath } from "../app-identity.js";
import {
  parseConfigOverrides,
  type AcceptedOverrides,
  type RejectedOverride,
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
  readBounded: (path: string, maxBytes: number) => Buffer;
  fsyncDir: (dirPath: string) => void;
}

export function createSettingsFs(overrides: Partial<SettingsFs> = {}): SettingsFs {
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
    readBounded(path: string, maxBytes: number): Buffer {
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
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
          const bytesRead = readSync(fd, buf, 0, toRead, null);
          if (bytesRead <= 0) break;
          chunks.push(bytesRead === toRead ? buf : buf.subarray(0, bytesRead));
          total += bytesRead;
        }
        return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
      } finally {
        closeSync(fd);
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

export interface ReadSettingsDocumentResult {
  doc: Record<string, unknown>;
  state: SettingsReadState;
  error?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function resolveSettingsPath(options?: SettingsStoreOptions): string {
  return options?.path ?? appHomePath("settings.json");
}

export function readSettingsDocument(options?: SettingsStoreOptions): ReadSettingsDocumentResult {
  const path = resolveSettingsPath(options);
  const fs = options?.fs ?? defaultFs;

  let stat: Stats;
  try {
    stat = fs.lstat(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { doc: {}, state: "missing" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { doc: {}, state: "unreadable", error: `Cannot stat settings file (${path}): ${msg}` };
  }

  if (stat.isSymbolicLink()) {
    return { doc: {}, state: "unreadable", error: `Settings path is a symlink (${path})` };
  }
  if (stat.isDirectory()) {
    return { doc: {}, state: "unreadable", error: `Settings path is a directory (${path})` };
  }
  if (!stat.isFile()) {
    return { doc: {}, state: "unreadable", error: `Settings path is not a regular file (${path})` };
  }

  let rawBytes: Buffer;
  try {
    rawBytes = fs.readBounded(path, MAX_SETTINGS_BYTES);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { doc: {}, state: "missing" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { doc: {}, state: "unreadable", error: `Cannot read settings file (${path}): ${msg}` };
  }

  if (rawBytes.byteLength > MAX_SETTINGS_BYTES) {
    return {
      doc: {},
      state: "unreadable",
      error: `Settings file (${path}) exceeds maximum size of ${MAX_SETTINGS_BYTES} bytes`,
    };
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    return { doc: {}, state: "corrupt", error: `Settings file (${path}) is not valid UTF-8` };
  }

  const text = decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { doc: {}, state: "corrupt", error: `Corrupt settings file (${path})` };
  }

  if (!isPlainObject(parsed)) {
    return {
      doc: {},
      state: "corrupt",
      error: `Corrupt settings file (${path}): root must be a JSON object`,
    };
  }

  return { doc: parsed, state: "ok" };
}

function writeDocumentAtomic(
  path: string,
  doc: Record<string, unknown>,
  fs: SettingsFs,
): { ok: true } | { ok: false; error: string } {
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

  let fd: number;
  try {
    fd = fs.openExclusive(tmpPath, 0o600);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  let closed = false;
  try {
    fs.write(fd, bytes);
    fs.fsync(fd);
    fs.close(fd);
    closed = true;
    try {
      fs.chmod(tmpPath, 0o600);
    } catch {
      // Ignore chmod failure on platforms without POSIX mode semantics.
    }
    fs.rename(tmpPath, path);
    try {
      fs.chmod(path, 0o600);
    } catch {
      // Ignore chmod failure on platforms without POSIX mode semantics.
    }
    try {
      fs.fsyncDir(dir);
    } catch {
      // Best-effort directory fsync after successful rename.
    }
    return { ok: true };
  } catch (err) {
    if (!closed) {
      try {
        fs.close(fd);
      } catch {
        // best-effort close
      }
    }
    try {
      fs.unlink(tmpPath);
    } catch {
      // best-effort temp cleanup
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function updateSettingsDocument(
  patch: Record<string, unknown>,
  options?: SettingsStoreOptions & { baseDefaultsIfMissing?: Record<string, unknown> },
): { ok: true; doc: Record<string, unknown> } | { ok: false; error: string } {
  const path = resolveSettingsPath(options);
  const fs = options?.fs ?? defaultFs;
  const current = readSettingsDocument({ path, fs });

  if (current.state === "corrupt" || current.state === "unreadable") {
    return {
      ok: false,
      error: current.error ?? `Cannot update ${current.state} settings file (${path})`,
    };
  }

  const nextDoc: Record<string, unknown> =
    current.state === "missing" && options?.baseDefaultsIfMissing
      ? { ...options.baseDefaultsIfMissing }
      : { ...current.doc };

  for (const key of Object.keys(patch)) {
    const val = patch[key];
    if (val === null) {
      delete nextDoc[key];
    } else if (val !== undefined) {
      nextDoc[key] = val;
    }
  }

  const written = writeDocumentAtomic(path, nextDoc, fs);
  if (!written.ok) return written;
  return { ok: true, doc: nextDoc };
}

export function replaceSettingsDocument(
  doc: Record<string, unknown>,
  options?: SettingsStoreOptions & { backupCorrupt?: boolean },
): { ok: true; doc: Record<string, unknown>; backupPath?: string } | { ok: false; error: string } {
  const path = resolveSettingsPath(options);
  const fs = options?.fs ?? defaultFs;
  const current = readSettingsDocument({ path, fs });

  if (current.state === "unreadable") {
    return {
      ok: false,
      error: current.error ?? `Cannot replace unreadable settings file (${path})`,
    };
  }

  let backupPath: string | undefined;
  if (current.state === "corrupt" && options?.backupCorrupt !== false) {
    backupPath = `${path}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    try {
      fs.copyFile(path, backupPath);
      try {
        fs.chmod(backupPath, 0o600);
      } catch {
        // Ignore chmod failure on platforms without POSIX mode semantics.
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Failed to back up corrupt settings file (${path}): ${msg}` };
    }
  }

  const copy = { ...doc };
  const written = writeDocumentAtomic(path, copy, fs);
  if (!written.ok) return written;
  return { ok: true, doc: copy, ...(backupPath ? { backupPath } : {}) };
}

export const REASONING_LEVELS = ["off", "none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

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
    if (
      typeof raw.reasoning === "string" &&
      (REASONING_LEVELS as readonly string[]).includes(raw.reasoning)
    ) {
      reasoning = raw.reasoning as ReasoningLevel;
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

function coerceLegacyBool(value: unknown): boolean | undefined {
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

  for (const key of USER_SETTINGS_KEYS) {
    const rawVal = doc[key];
    if (rawVal === undefined) continue;
    if (key === "thinking" || key === "incognito" || key === "debug" || key === "auto_update") {
      const b = coerceLegacyBool(rawVal);
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

  const dm = parseDefaultModel(doc.default_model);
  invalidKeys.push(...dm.errors);

  let configOverrides: AcceptedOverrides = {};
  let rejectedOverrides: RejectedOverride[] = [];
  if (doc.config_overrides !== undefined) {
    if (!isPlainObject(doc.config_overrides)) {
      const reason = "config_overrides must be a plain object";
      invalidKeys.push({ key: "config_overrides", reason });
      rejectedOverrides.push({ path: "config_overrides", reason });
    } else {
      const parsedOverrides = parseConfigOverrides(doc.config_overrides);
      configOverrides = parsedOverrides.accepted;
      rejectedOverrides = parsedOverrides.rejected;
    }
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
    settings,
    defaultModel: dm.value,
    configOverrides,
    invalidKeys,
    ignoredUnknownKeys,
    rejectedOverrides,
    state: "ok",
    warnings,
  };
}
