import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
  type Stats,
} from "node:fs";

/** Product identity — single source of truth for rename-sensitive strings. */
export const APP_NAME = "PRAANA";
export const APP_TAGLINE =
  "Persistent Reasoning Agent with Adaptive Navigation and Action";
export const APP_AGENT_ID = "praana";

export const APP_HOME_DIR = ".praana";

export const CLI_NAME = "praana";

/** Owner-only mode for directories PRAANA creates (app home, sessions, logs). */
export const APP_HOME_DIR_MODE = 0o700;

export function appHomePath(...parts: string[]): string {
  const praanaHome = envOverride("PRAANA_HOME");
  const base = praanaHome
    ? join(praanaHome, APP_HOME_DIR)
    : join(homedir(), APP_HOME_DIR);
  return join(base, ...parts);
}

/**
 * Create `appHomePath(...parts)` (and any missing parents) owner-only and
 * return the path. The app home itself is created first, so it is private even
 * when `parts` is empty or the first command to run creates a nested directory.
 * `recursive` applies the mode to every directory it creates; existing
 * directories are left alone (see `tightenAppHomePermissions`).
 */
export function ensureAppHome(...parts: string[]): string {
  mkdirSync(appHomePath(), { recursive: true, mode: APP_HOME_DIR_MODE });
  const dir = appHomePath(...parts);
  if (parts.length > 0) {
    mkdirSync(dir, { recursive: true, mode: APP_HOME_DIR_MODE });
  }
  return dir;
}

export function isFirstRun(): boolean {
  return !existsSync(appHomePath(".initialized"));
}

export function markInitialized(): boolean {
  try {
    ensureAppHome();
    writeFileSync(appHomePath(".initialized"), new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

/** Minimal path module surface — injectable so Windows paths can be tested on any host. */
export interface PathResolver {
  isAbsolute(path: string): boolean;
  join(...paths: string[]): string;
}

const defaultPathResolver: PathResolver = { isAbsolute, join };

/**
 * Join a configured path onto `cwd` unless it is already absolute.
 * Uses the host path module by default so Windows drive (`C:\...`) and UNC
 * (`\\server\share\...`) paths are recognized as absolute.
 */
export function resolveAgainstCwd(
  p: string,
  cwd: string,
  pathImpl: PathResolver = defaultPathResolver,
): string {
  if (p === ":memory:") return p;
  return pathImpl.isAbsolute(p) ? p : pathImpl.join(cwd, p);
}

export function resolveDefaultMemoryDbPath(): string {
  return appHomePath("memory.db");
}

export function resolveDefaultSessionLogDir(): string {
  return appHomePath("sessions");
}

export function resolveDefaultAppLogDir(): string {
  return appHomePath("logs");
}

/** Injectable `fs` seams — the defaults are the real `node:fs` implementations. */
export interface AppHomePermissionFixes {
  chmod?: (path: string, mode: number) => void;
  /** Must not follow symlinks (default `lstatSync`). */
  lstat?: (path: string) => Pick<Stats, "mode" | "uid" | "isSymbolicLink">;
  /** Current user id; `undefined` where the platform has none. */
  getuid?: () => number | undefined;
  /** Called with the path and error when a fix-up fails; never throws out. */
  onError?: (path: string, err: unknown) => void;
}

/**
 * Reason reported through `onError` when a symlinked app-home directory is left
 * alone: a fix-up never chmods through a link. Reported as the message of an
 * `Error`, so a reporter that logs `(err as Error).message` shows the reason.
 */
export const APP_HOME_SYMLINK_SKIP_REASON = "symlink skipped";

/** Report a skipped symlink through the best-effort `onError` seam. */
function reportSymlinkSkipped(dir: string, deps: AppHomePermissionFixes): void {
  try {
    deps.onError?.(dir, new Error(APP_HOME_SYMLINK_SKIP_REASON));
  } catch {
    // Reporting is best effort too.
  }
}

/**
 * Mode an existing app-home directory is tightened to: exactly
 * `APP_HOME_DIR_MODE`. Group and "other" access go, and so do setgid, setuid
 * and sticky. 0755, 0750, 0775, 2775 and 2770 all become 0700; a directory
 * that already has no bit outside the owner's rwx is left as it is.
 */
export function tightenedDirMode(mode: number): number {
  const current = mode & 0o7777;
  // `~0o700` covers group rwx, other rwx, setuid, setgid and sticky.
  return (current & ~0o700) === 0 ? current : APP_HOME_DIR_MODE;
}

/**
 * Tighten one existing directory to `APP_HOME_DIR_MODE` (see
 * `tightenedDirMode`). Skips a missing path, a symlink (never chmod through a
 * link) and a directory owned by another user. A skip or failure is best
 * effort: it is reported through `deps.onError` (a symlink as
 * `APP_HOME_SYMLINK_SKIP_REASON`) and never throws. No-op on Windows.
 * Returns true when the mode was changed.
 */
export function tightenDirPermissions(
  dir: string,
  deps: AppHomePermissionFixes = {},
): boolean {
  if (process.platform === "win32") return false;
  const chmod = deps.chmod ?? chmodSync;
  const lstat = deps.lstat ?? lstatSync;
  const getuid = deps.getuid ?? (() => process.getuid?.());
  try {
    let stat;
    try {
      stat = lstat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      reportSymlinkSkipped(dir, deps);
      return false;
    }
    const uid = getuid();
    if (uid !== undefined && stat.uid !== uid) return false;
    const current = stat.mode & 0o7777;
    const target = tightenedDirMode(current);
    if (target === current) return false;
    chmod(dir, target);
    return true;
  } catch (err) {
    try {
      deps.onError?.(dir, err);
    } catch {
      // Reporting is best effort too.
    }
    return false;
  }
}

function isSymlink(path: string, deps: AppHomePermissionFixes): boolean {
  try {
    return (deps.lstat ?? lstatSync)(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Best-effort startup fix-up: make an existing app home, sessions root and app
 * logs directory `0700`. Directories created before the `0700` enforcement
 * keep the default umask (`0755`), which lets any local user read session
 * transcripts. Only paths inside the app home are touched; it never fails
 * startup.
 */
export function tightenAppHomePermissions(deps: AppHomePermissionFixes = {}): void {
  const home = appHomePath();
  // A symlinked app home points somewhere PRAANA did not create: leave the
  // whole tree alone rather than chmod directories reached through the link.
  if (isSymlink(home, deps)) {
    reportSymlinkSkipped(home, deps);
    return;
  }
  for (const dir of [home, resolveDefaultSessionLogDir(), resolveDefaultAppLogDir()]) {
    tightenDirPermissions(dir, deps);
  }
}

export function envOverride(primary: string): string | undefined {
  const value = process.env[primary]?.trim();
  return value || undefined;
}

export function envFlag(primary: string): boolean | undefined {
  const raw = envOverride(primary);
  if (raw === undefined) return undefined;
  return raw === "true" || raw === "1";
}
