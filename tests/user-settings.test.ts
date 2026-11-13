import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APP_HOME_DIR } from "../src/app-identity.js";
import { createSettingsFs } from "../src/settings/store.js";
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

  it("updateUserSettings refuses to overwrite a corrupt file and preserves unknown top-level keys", () => {
    writeFileSync(getUserSettingsPath(), "{corrupt", "utf-8");
    const badUpdate = updateUserSettings({ thinking: false });
    expect(badUpdate.ok).toBe(false);
    expect(readFileSync(getUserSettingsPath(), "utf-8")).toBe("{corrupt");

    writeFileSync(
      getUserSettingsPath(),
      JSON.stringify({ thinking: true, extra_future_key: { nested: 42 } }, null, 2) + "\n",
      "utf-8",
    );
    const okUpdate = updateUserSettings({ thinking: false });
    expect(okUpdate.ok).toBe(true);
    const onDisk = JSON.parse(readFileSync(getUserSettingsPath(), "utf-8"));
    expect(onDisk.thinking).toBe(false);
    expect(onDisk.extra_future_key).toEqual({ nested: 42 });
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

  it("resetUserSettings decides corrupt vs valid state inside the lock (no unlocked read race)", () => {
    const settingsPath = getUserSettingsPath();
    const corruptBytes = "{corrupt-before-repair";
    const repairedDoc = {
      thinking: false,
      default_model: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      config_overrides: { "edit.confirm": true },
      custom_key: "preserve-me",
    };
    writeFileSync(settingsPath, corruptBytes, "utf-8");

    const baseFs = createSettingsFs();
    let readCount = 0;
    const interleavingFs = createSettingsFs({
      readBounded(p, maxBytes) {
        const bytes = baseFs.readBounded(p, maxBytes);
        if (p === settingsPath) {
          readCount++;
          if (readCount === 1) {
            // Simulate another process repairing the file right after an unlocked read.
            writeFileSync(settingsPath, JSON.stringify(repairedDoc, null, 2) + "\n", "utf-8");
          }
        }
        return bytes;
      },
    });

    const reset = resetUserSettings({ fs: interleavingFs });
    expect(reset.ok).toBe(true);
    // Must not read before acquiring the lock.
    expect(readCount).toBe(1);

    const homeDir = join(root, APP_HOME_DIR);
    const backups = readdirSync(homeDir).filter((f) => f.startsWith("settings.json.corrupt-"));
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Either corrupt bytes were backed up (when lock ran before repair) or repaired keys were preserved.
    const backedUp = backups.length === 1;
    const preserved =
      onDisk.custom_key === "preserve-me" &&
      onDisk.default_model?.model === "claude-sonnet-4-20250514" &&
      onDisk.config_overrides?.["edit.confirm"] === true;
    expect(backedUp || preserved).toBe(true);
    if (backedUp && process.platform !== "win32") {
      expect(statSync(join(homeDir, backups[0] ?? "")).mode & 0o777).toBe(0o600);
    }
  });

  it("loadUserSettings handles a concurrent valid write between initial missing read and lock without rewriting or setting createdDefaults", () => {
    const settingsPath = getUserSettingsPath();
    const concurrentDoc = { thinking: false, custom_key: "from-other-process" };
    const baseFs = createSettingsFs();
    let lstatCalls = 0;
    let openExclusiveCalls = 0;
    let renameCalls = 0;

    const interleavingFs = createSettingsFs({
      lstat(p) {
        if (p === settingsPath) {
          lstatCalls++;
          if (lstatCalls === 1) {
            try {
              return baseFs.lstat(p);
            } catch (err) {
              // After returning ENOENT on the unlocked read, another process writes a valid file.
              writeFileSync(settingsPath, JSON.stringify(concurrentDoc, null, 2) + "\n", "utf-8");
              throw err;
            }
          }
        }
        return baseFs.lstat(p);
      },
      openExclusive(p, mode) {
        openExclusiveCalls++;
        return baseFs.openExclusive(p, mode);
      },
      rename(oldPath, newPath) {
        renameCalls++;
        return baseFs.rename(oldPath, newPath);
      },
    });

    const loaded = loadUserSettings({ fs: interleavingFs });
    expect(loaded.createdDefaults).toBeUndefined();
    expect(loaded.warning).toBeUndefined();
    expect(loaded.settings.thinking).toBe(false);
    expect(openExclusiveCalls).toBe(0);
    expect(renameCalls).toBe(0);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(concurrentDoc);
  });

  it("loadUserSettings reports corrupt warning (not Could not create) when file becomes corrupt before lock", () => {
    const settingsPath = getUserSettingsPath();
    const baseFs = createSettingsFs();
    let lstatCalls = 0;

    const interleavingFs = createSettingsFs({
      lstat(p) {
        if (p === settingsPath) {
          lstatCalls++;
          if (lstatCalls === 1) {
            try {
              return baseFs.lstat(p);
            } catch (err) {
              writeFileSync(settingsPath, "{corrupt-from-other-process", "utf-8");
              throw err;
            }
          }
        }
        return baseFs.lstat(p);
      },
    });

    const loaded = loadUserSettings({ fs: interleavingFs });
    expect(loaded.createdDefaults).toBeUndefined();
    expect(loaded.warning).toContain("Corrupt settings file");
    expect(loaded.warning).not.toContain("Could not create settings file");
    expect(loaded.settings).toEqual(DEFAULT_USER_SETTINGS);
  });
});
