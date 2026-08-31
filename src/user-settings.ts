/**
 * Persistent user preferences (`~/.praana/settings.json`).
 *
 * Distinct from `praana.config.toml`: config is project/infra defaults;
 * settings are cross-session UX preferences applied as session defaults.
 * Session-scoped slash commands (`/model`, `/thinking`, etc.) do not write here —
 * only `/settings set` / `/settings reset` persist.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { appHomePath } from "./app-identity.js";

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

export function getUserSettingsPath(): string {
  return appHomePath("settings.json");
}

export function isUserSettingsKey(key: string): key is UserSettingsKey {
  return (USER_SETTINGS_KEYS as readonly string[]).includes(key);
}

export interface LoadUserSettingsResult {
  settings: UserSettings;
  /** Present when the file was missing, corrupt, or partially invalid. */
  warning?: string;
  /** True when settings.json did not exist (defaults used). */
  createdDefaults?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceBoolean(value: unknown): boolean | undefined {
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

function coerceString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim();
  return undefined;
}

/** Parse a CLI-style boolean token for `/settings set`. */
export function parseSettingsBoolean(raw: string): boolean | undefined {
  return coerceBoolean(raw);
}

/**
 * Merge a raw JSON object onto defaults, ignoring unknown keys and bad types.
 * Returns the merged settings and whether any fields were skipped/invalid.
 */
export function normalizeUserSettings(
  raw: unknown,
): { settings: UserSettings; invalid: boolean } {
  const settings: UserSettings = { ...DEFAULT_USER_SETTINGS };
  if (!isPlainObject(raw)) {
    return { settings, invalid: true };
  }

  let invalid = false;

  const model = coerceString(raw.model);
  if (raw.model !== undefined) {
    if (model === undefined) invalid = true;
    else settings.model = model;
  }

  const provider = coerceString(raw.provider);
  if (raw.provider !== undefined) {
    if (provider === undefined) invalid = true;
    else settings.provider = provider;
  }

  const thinking = coerceBoolean(raw.thinking);
  if (raw.thinking !== undefined) {
    if (thinking === undefined) invalid = true;
    else settings.thinking = thinking;
  }

  const incognito = coerceBoolean(raw.incognito);
  if (raw.incognito !== undefined) {
    if (incognito === undefined) invalid = true;
    else settings.incognito = incognito;
  }

  const debug = coerceBoolean(raw.debug);
  if (raw.debug !== undefined) {
    if (debug === undefined) invalid = true;
    else settings.debug = debug;
  }

  const theme = coerceString(raw.theme);
  if (raw.theme !== undefined) {
    if (theme === undefined || theme.length === 0) invalid = true;
    else settings.theme = theme;
  }

  const autoUpdate = coerceBoolean(raw.auto_update);
  if (raw.auto_update !== undefined) {
    if (autoUpdate === undefined) invalid = true;
    else settings.auto_update = autoUpdate;
  }

  return { settings, invalid };
}

function atomicWriteJson(path: string, data: UserSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Load settings from disk. Missing file → defaults (and create the file).
 * Corrupt JSON → defaults + warning (does not overwrite the bad file).
 */
export function loadUserSettings(): LoadUserSettingsResult {
  const path = getUserSettingsPath();
  if (!existsSync(path)) {
    const settings = { ...DEFAULT_USER_SETTINGS };
    try {
      atomicWriteJson(path, settings);
      return { settings, createdDefaults: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        settings,
        warning: `Could not create settings file (${path}): ${msg}`,
        createdDefaults: true,
      };
    }
  }

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      settings: { ...DEFAULT_USER_SETTINGS },
      warning: `Could not read settings file (${path}): ${msg}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      settings: { ...DEFAULT_USER_SETTINGS },
      warning: `Corrupt settings file (${path}); using defaults`,
    };
  }

  const { settings, invalid } = normalizeUserSettings(parsed);
  if (invalid) {
    return {
      settings,
      warning: `Invalid fields in settings file (${path}); invalid keys ignored`,
    };
  }
  return { settings };
}

/** Write full settings object to disk. */
export function saveUserSettings(settings: UserSettings): { ok: true } | { ok: false; error: string } {
  const path = getUserSettingsPath();
  try {
    const { settings: normalized } = normalizeUserSettings(settings);
    atomicWriteJson(path, normalized);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Update one or more keys and persist. Returns the merged settings.
 */
export function updateUserSettings(
  patch: Partial<UserSettings>,
): { ok: true; settings: UserSettings } | { ok: false; error: string } {
  const loaded = loadUserSettings();
  const merged: UserSettings = { ...loaded.settings, ...patch };
  const saved = saveUserSettings(merged);
  if (!saved.ok) return saved;
  return { ok: true, settings: merged };
}

/** Reset file to defaults and return them. */
export function resetUserSettings():
  | { ok: true; settings: UserSettings }
  | { ok: false; error: string } {
  const settings = { ...DEFAULT_USER_SETTINGS };
  const saved = saveUserSettings(settings);
  if (!saved.ok) return saved;
  return { ok: true, settings };
}

/**
 * Apply a `/settings set <key> <value>` token pair.
 * Returns an error string on validation failure.
 */
export function parseSettingsSetValue(
  key: UserSettingsKey,
  rawValue: string,
): { ok: true; value: string | boolean } | { ok: false; error: string } {
  if (key === "thinking" || key === "incognito" || key === "debug" || key === "auto_update") {
    const bool = parseSettingsBoolean(rawValue);
    if (bool === undefined) {
      return { ok: false, error: `Invalid boolean for ${key}: use on|off|true|false` };
    }
    return { ok: true, value: bool };
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return { ok: false, error: `${key} cannot be empty` };
  }
  return { ok: true, value: trimmed };
}
