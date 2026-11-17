import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { getAppLogger } from "./logger.js";

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

export function isFirstRun(): boolean {
  return !existsSync(appHomePath(".initialized"));
}

export function markInitialized(): boolean {
  try {
    mkdirSync(appHomePath(), { recursive: true, mode: APP_HOME_DIR_MODE });
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

/** Injectable `fs` seams — the default is the real `node:fs` implementation. */
export interface AppHomePermissionFixes {
  chmod?: (path: string, mode: number) => void;
}

/**
 * Best-effort startup fix-up: make an existing app home and sessions root
 * owner-only (`0700`). Directories created before the `0700` enforcement keep
 * the default umask (`0755`), which lets any local user read session
 * transcripts. Only paths inside the app home are touched, modes are not
 * enforced on Windows, and a failure is logged at debug level — it never fails
 * startup.
 */
export function tightenAppHomePermissions(deps: AppHomePermissionFixes = {}): void {
  if (process.platform === "win32") return;
  const chmod = deps.chmod ?? chmodSync;
  for (const dir of [appHomePath(), resolveDefaultSessionLogDir()]) {
    try {
      if (!existsSync(dir)) continue;
      // Only fix directories that are more permissive than 0700.
      if ((statSync(dir).mode & 0o077) === 0) continue;
      chmod(dir, APP_HOME_DIR_MODE);
    } catch (err) {
      try {
        getAppLogger().debug("failed to tighten app home permissions", {
          details: { path: dir, cause: (err as Error)?.message },
        });
      } catch {
        // Logging is best effort too.
      }
    }
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
