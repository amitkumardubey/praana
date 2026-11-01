import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";

/** Product identity — single source of truth for rename-sensitive strings. */
export const APP_NAME = "PRAANA";
export const APP_TAGLINE =
  "Persistent Reasoning Agent with Adaptive Navigation and Action";
export const APP_AGENT_ID = "praana";

export const APP_HOME_DIR = ".praana";

export const CLI_NAME = "praana";

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
    mkdirSync(appHomePath(), { recursive: true });
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

export function envOverride(primary: string): string | undefined {
  const value = process.env[primary]?.trim();
  return value || undefined;
}

export function envFlag(primary: string): boolean | undefined {
  const raw = envOverride(primary);
  if (raw === undefined) return undefined;
  return raw === "true" || raw === "1";
}
