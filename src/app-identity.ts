import { homedir } from "node:os";
import { join } from "node:path";

/** Product identity — single source of truth for rename-sensitive strings. */
export const APP_NAME = "PRAANA";
export const APP_TAGLINE =
  "Persistent Reasoning Agent with Adaptive Navigation and Action";
export const APP_AGENT_ID = "praana";

export const APP_HOME_DIR = ".praana";

export const CLI_NAME = "praana";
export const CLI_SHORT = "pran";

export function appHomePath(...parts: string[]): string {
  return join(homedir(), APP_HOME_DIR, ...parts);
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
