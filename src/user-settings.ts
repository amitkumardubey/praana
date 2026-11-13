/**
 * Persistent user preferences (`~/.praana/settings.json`).
 *
 * Distinct from `praana.config.toml`: config is project/infra defaults;
 * settings are cross-session UX preferences applied as session defaults.
 * Session-scoped slash commands (`/model`, `/thinking`, etc.) do not write here —
 * only `/settings set` / `/settings reset` persist.
 */

import {
  coerceBoolean,
  DEFAULT_USER_SETTINGS,
  normalizeLegacySettings,
  settingsFilePath,
  readSettingsDocument,
  updateSettingsDocument,
  USER_SETTINGS_KEYS,
  type SettingsStoreOptions,
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
  return settingsFilePath();
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
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { settings: { ...DEFAULT_USER_SETTINGS }, invalid: true };
  }
  const { settings, invalidKeys } = normalizeLegacySettings(raw as Record<string, unknown>);
  return { settings, invalid: invalidKeys.length > 0 };
}

/**
 * Load settings from disk. Missing file → defaults (and create the file with mode 0600).
 * Corrupt JSON or unreadable file → defaults + warning (does not overwrite the bad file).
 */
export function loadUserSettings(options?: SettingsStoreOptions): LoadUserSettingsResult {
  const path = options?.path ?? getUserSettingsPath();
  const fs = options?.fs;
  const read = readSettingsDocument({ path, fs });

  if (read.state === "missing") {
    const settings = { ...DEFAULT_USER_SETTINGS };
    const written = updateSettingsDocument(
      {},
      { path, fs, baseDefaultsIfMissing: { ...settings }, createOnly: true },
    );
    if (!written.ok) {
      if (written.state === "corrupt") {
        return {
          settings,
          warning: `Corrupt settings file (${path}); using defaults`,
        };
      }
      if (written.state === "unreadable") {
        return {
          settings,
          warning: `Could not read settings file (${path}): ${written.error}`,
        };
      }
      return {
        settings,
        warning: `Could not create settings file (${path}): ${written.error}`,
      };
    }
    const { settings: normalized, invalid } = normalizeUserSettings(written.doc);
    if (written.created) {
      return { settings: normalized, createdDefaults: true };
    }
    if (invalid) {
      return {
        settings: normalized,
        warning: `Invalid fields in settings file (${path}); invalid keys ignored`,
      };
    }
    return { settings: normalized };
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
  const patch: Record<string, unknown> = Object.fromEntries(
    USER_SETTINGS_KEYS.map((key) => [key, normalized[key]]),
  );
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
 * `config_overrides`, and unknown keys (those are cleared by their own actions).
 * When the existing file is corrupt, backs it up to
 * `settings.json.corrupt-<timestamp>` (0600) first and then writes default
 * legacy fields. Never replaces an unreadable file.
 */
export function resetUserSettings(
  options?: SettingsStoreOptions,
): { ok: true; settings: UserSettings } | { ok: false; error: string } {
  const path = options?.path ?? getUserSettingsPath();
  const fs = options?.fs;
  const defaults = { ...DEFAULT_USER_SETTINGS };
  const updated = updateSettingsDocument(
    { ...defaults },
    { path, fs, baseDefaultsIfMissing: { ...defaults }, onCorrupt: "backup-and-reset-legacy" },
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
