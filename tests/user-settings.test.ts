import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APP_HOME_DIR } from "../src/app-identity.js";
import {
  DEFAULT_USER_SETTINGS,
  getUserSettingsPath,
  loadUserSettings,
  normalizeUserSettings,
  parseSettingsBoolean,
  parseSettingsSetValue,
  resetUserSettings,
  saveUserSettings,
  updateUserSettings,
} from "../src/user-settings.js";

describe("user-settings", () => {
  const originalPraanaHome = process.env.PRAANA_HOME;
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `praana-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, APP_HOME_DIR), { recursive: true });
    process.env.PRAANA_HOME = root;
  });

  afterEach(() => {
    if (originalPraanaHome !== undefined) {
      process.env.PRAANA_HOME = originalPraanaHome;
    } else {
      delete process.env.PRAANA_HOME;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("getUserSettingsPath respects PRAANA_HOME", () => {
    expect(getUserSettingsPath()).toBe(join(root, APP_HOME_DIR, "settings.json"));
  });

  it("loadUserSettings creates defaults when file is missing", () => {
    const result = loadUserSettings();
    expect(result.createdDefaults).toBe(true);
    expect(result.settings).toEqual(DEFAULT_USER_SETTINGS);
    expect(existsSync(getUserSettingsPath())).toBe(true);
    const onDisk = JSON.parse(readFileSync(getUserSettingsPath(), "utf-8"));
    expect(onDisk.thinking).toBe(true);
  });

  it("loadUserSettings returns defaults + warning on corrupt JSON", () => {
    writeFileSync(getUserSettingsPath(), "{not-json", "utf-8");
    const result = loadUserSettings();
    expect(result.settings).toEqual(DEFAULT_USER_SETTINGS);
    expect(result.warning).toContain("Corrupt settings file");
    // Does not overwrite the corrupt file
    expect(readFileSync(getUserSettingsPath(), "utf-8")).toBe("{not-json");
  });

  it("saveUserSettings round-trips", () => {
    const saved = saveUserSettings({
      model: "gpt-4o",
      provider: "openai",
      thinking: false,
      incognito: true,
      debug: true,
      theme: "nord",
      auto_update: false,
    });
    expect(saved.ok).toBe(true);
    const loaded = loadUserSettings();
    expect(loaded.settings.model).toBe("gpt-4o");
    expect(loaded.settings.provider).toBe("openai");
    expect(loaded.settings.thinking).toBe(false);
    expect(loaded.settings.incognito).toBe(true);
    expect(loaded.settings.debug).toBe(true);
    expect(loaded.settings.theme).toBe("nord");
  });

  it("updateUserSettings merges a patch", () => {
    saveUserSettings({ ...DEFAULT_USER_SETTINGS, thinking: true });
    const updated = updateUserSettings({ thinking: false, debug: true });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.settings.thinking).toBe(false);
    expect(updated.settings.debug).toBe(true);
    expect(loadUserSettings().settings.thinking).toBe(false);
  });

  it("resetUserSettings restores defaults", () => {
    saveUserSettings({
      model: "x",
      provider: "y",
      thinking: false,
      incognito: true,
      debug: true,
      theme: "custom",
      auto_update: false,
    });
    const reset = resetUserSettings();
    expect(reset.ok).toBe(true);
    if (!reset.ok) return;
    expect(reset.settings).toEqual(DEFAULT_USER_SETTINGS);
    expect(loadUserSettings().settings).toEqual(DEFAULT_USER_SETTINGS);
  });

  it("normalizeUserSettings ignores unknown keys and bad types", () => {
    const { settings, invalid } = normalizeUserSettings({
      thinking: "nope",
      model: 42,
      theme: "ok",
      unknown: true,
    });
    expect(invalid).toBe(true);
    expect(settings.theme).toBe("ok");
    expect(settings.thinking).toBe(DEFAULT_USER_SETTINGS.thinking);
    expect(settings.model).toBe(DEFAULT_USER_SETTINGS.model);
  });

  it("parseSettingsBoolean accepts common tokens", () => {
    expect(parseSettingsBoolean("on")).toBe(true);
    expect(parseSettingsBoolean("true")).toBe(true);
    expect(parseSettingsBoolean("1")).toBe(true);
    expect(parseSettingsBoolean("off")).toBe(false);
    expect(parseSettingsBoolean("false")).toBe(false);
    expect(parseSettingsBoolean("0")).toBe(false);
    expect(parseSettingsBoolean("maybe")).toBeUndefined();
  });

  it("parseSettingsSetValue validates keys", () => {
    expect(parseSettingsSetValue("thinking", "off")).toEqual({ ok: true, value: false });
    expect(parseSettingsSetValue("model", "  gpt-4o  ")).toEqual({ ok: true, value: "gpt-4o" });
    expect(parseSettingsSetValue("model", "  ").ok).toBe(false);
    expect(parseSettingsSetValue("debug", "maybe").ok).toBe(false);
  });

  it("auto_update defaults to false and parses on/off", () => {
    expect(DEFAULT_USER_SETTINGS.auto_update).toBe(false);
    expect(parseSettingsSetValue("auto_update", "on")).toEqual({ ok: true, value: true });
    expect(parseSettingsSetValue("auto_update", "off")).toEqual({ ok: true, value: false });
    const created = loadUserSettings();
    expect(created.settings.auto_update).toBe(false);
  });
});
