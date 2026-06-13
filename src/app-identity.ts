import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Product identity — single source of truth for rename-sensitive strings. */
export const APP_NAME = "PRAANA";
export const APP_TAGLINE =
  "Persistent Reasoning Agent with Adaptive Navigation and Action";
export const APP_AGENT_ID = "praana";
/** Memory entries written before the PRAANA rename used this agent scope. */
export const LEGACY_APP_AGENT_ID = "aria";

export const APP_HOME_DIR = ".praana";
export const LEGACY_APP_HOME_DIR = ".aria";

export const CLI_NAME = "praana";
export const CLI_SHORT = "pran";

export function appHomePath(...parts: string[]): string {
  return join(homedir(), APP_HOME_DIR, ...parts);
}

export function legacyAppHomePath(...parts: string[]): string {
  return join(homedir(), LEGACY_APP_HOME_DIR, ...parts);
}

/** Prefer PRAANA home; fall back to legacy ~/.aria when the new dir is unused. */
export function resolveAppHomePath(...parts: string[]): string {
  const next = appHomePath(...parts);
  if (parts.length === 0) {
    return existsSync(next) || !existsSync(legacyAppHomePath())
      ? next
      : legacyAppHomePath();
  }
  if (existsSync(next)) return next;
  const legacy = legacyAppHomePath(...parts);
  return existsSync(legacy) ? legacy : next;
}

export function resolveDefaultMemoryDbPath(): string {
  return resolveAppHomePath("memory.db");
}

export function resolveDefaultSessionLogDir(): string {
  return resolveAppHomePath("sessions");
}

export function envOverride(primary: string, legacy?: string): string | undefined {
  const value = process.env[primary]?.trim();
  if (value) return value;
  if (!legacy) return undefined;
  return process.env[legacy]?.trim() || undefined;
}

export function envFlag(primary: string, legacy?: string): boolean | undefined {
  const raw = envOverride(primary, legacy);
  if (raw === undefined) return undefined;
  return raw === "true" || raw === "1";
}
