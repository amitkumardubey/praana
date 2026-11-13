/**
 * Persistent user preferences (`~/.praana/settings.json`).
 *
 * Distinct from `praana.config.toml`: config is project/infra defaults;
 * settings are cross-session UX preferences applied as session defaults.
 * Session-scoped slash commands (`/model`, `/thinking`, etc.) do not write here —
 * only `/settings set` / `/settings reset` persist.
 */

import { appHomePath } from "./app-identity.js";
import {
  DEFAULT_USER_SETTINGS,
  readSettingsDocument,
  replaceSettingsDocument,
  updateSettingsDocument,
  USER_SETTINGS_KEYS,
  type UserSettings,
  type UserSettingsKey,
} from "./settings/store.js";

export {
  DEFAULT_USER_SETTINGS,
  USER_SETTINGS_KEYS,
  type UserSettings,
  type UserSettingsKey,
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

/**
 * Load settings from disk. Missing file → defaults (and create the file with mode 0600).
 * Corrupt JSON or unreadable file → defaults + warning (does not overwrite the bad file).
 */
export function loadUserSettings(): LoadUserSettingsResult {
  const path = getUserSettingsPath();
  const read = readSettingsDocument({ path });

  if (read.state === "missing") {
    const settings = { ...DEFAULT_USER_SETTINGS };
    const written = replaceSettingsDocument(
      { ...settings },
      { path, backupCorrupt: false },
    );
    if (!written.ok) {
      return {
        settings,
        warning: `Could not create settings file (${path}): ${written.error}`,
        createdDefaults: true,
      };
    }
    return { settings, createdDefaults: true };
  }

  if (read.state === "unreadable") {
    return {
      settings: { ...DEFAULT_USER_SETTINGS },
      warning: `Could not read settings file (${path}): ${read.error ?? "unreadable"}`,
    };
  }

  if (read.state === "corrupt") {
    return {
      settings: { ...DEFAULT_USER_SETTINGS },
      warning: `Corrupt settings file (${path}); using defaults`,
    };
  }

  const { settings, invalid } = normalizeUserSettings(read.doc);
  if (invalid) {
    return {
      settings,
      warning: `Invalid fields in settings file (${path}); invalid keys ignored`,
    };
  }
  return { settings };
}

/**
 * Replace only the seven legacy fields in the document on disk; every other key
 * (`default_model`, `config_overrides`, unknown keys) is preserved. Never
 * overwrites a corrupt or unreadable file.
 */
export function saveUserSettings(settings: UserSettings): { ok: true } | { ok: false; error: string } {
  const { settings: normalized } = normalizeUserSettings(settings);
  const patch: Record<string, unknown> = {
    model: normalized.model,
    provider: normalized.provider,
    thinking: normalized.thinking,
    incognito: normalized.incognito,
    debug: normalized.debug,
    theme: normalized.theme,
    auto_update: normalized.auto_update,
  };
  const updated = updateSettingsDocument(patch, {
    baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS },
  });
  if (!updated.ok) return updated;
  return { ok: true };
}

/**
 * Apply a sparse patch for the caller's named legacy keys and persist.
 * Preserves unrelated legacy keys written by other processes as well as
 * `default_model`, `config_overrides`, and unknown keys. Never overwrites
 * a corrupt or unreadable file.
 */
export function updateUserSettings(
  patch: Partial<UserSettings>,
): { ok: true; settings: UserSettings } | { ok: false; error: string } {
  const sparsePatch: Record<string, unknown> = {};
  for (const key of USER_SETTINGS_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key) || patch[key] === undefined) continue;
    const { settings: normalizedKey, invalid } = normalizeUserSettings({ [key]: patch[key] });
    if (invalid) {
      return { ok: false, error: `Invalid value for setting "${key}"` };
    }
    sparsePatch[key] = normalizedKey[key];
  }

  const updated = updateSettingsDocument(sparsePatch, {
    baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS },
  });
  if (!updated.ok) return updated;
  const { settings } = normalizeUserSettings(updated.doc);
  return { ok: true, settings };
}

/**
 * Reset only the seven legacy fields to defaults, preserving `default_model`,
 * `config_overrides`, and unknown keys (those have their own clear actions in
 * later slices). When the existing file is corrupt, backs it up to
 * `settings.json.corrupt-<timestamp>` (0600) first and then writes default
 * legacy fields. Never replaces an unreadable file.
 */
export function resetUserSettings():
  | { ok: true; settings: UserSettings }
  | { ok: false; error: string } {
  const path = getUserSettingsPath();
  const current = readSettingsDocument({ path });
  if (current.state === "unreadable") {
    return {
      ok: false,
      error: current.error ?? `Cannot reset unreadable settings file (${path})`,
    };
  }
  const defaults = { ...DEFAULT_USER_SETTINGS };
  if (current.state === "corrupt") {
    const replaced = replaceSettingsDocument({ ...defaults }, { path, backupCorrupt: true });
    if (!replaced.ok) return replaced;
    return { ok: true, settings: defaults };
  }
  const updated = updateSettingsDocument(
    { ...defaults },
    { path, baseDefaultsIfMissing: { ...defaults } },
  );
  if (!updated.ok) return updated;
  return { ok: true, settings: defaults };
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
