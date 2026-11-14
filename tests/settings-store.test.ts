import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOME_DIR } from "../src/app-identity.js";
import { resolveActiveModelAndProvider } from "../src/llm/resolver.js";
import { createTestLogger, getAppLogger, PraanaLogger, setAppLogger } from "../src/logger.js";
import {
  DEFAULT_USER_SETTINGS,
  getUserSettingsPath,
  loadUserSettings,
  resetUserSettings,
  saveUserSettings,
  updateUserSettings,
} from "../src/user-settings.js";

const storeApi = () => import("../src/settings/store.js");

describe("settings store", () => {
  const originalPraanaHome = process.env.PRAANA_HOME;
  let root: string;
  let homeDir: string;
  let settingsPath: string;

  beforeEach(() => {
    root = join(tmpdir(), `praana-s1a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    homeDir = join(root, APP_HOME_DIR);
    mkdirSync(homeDir, { recursive: true });
    process.env.PRAANA_HOME = root;
    settingsPath = getUserSettingsPath();
  });

  afterEach(() => {
    if (originalPraanaHome !== undefined) {
      process.env.PRAANA_HOME = originalPraanaHome;
    } else {
      delete process.env.PRAANA_HOME;
    }
    try {
      chmodSync(homeDir, 0o700);
      if (existsSync(settingsPath) && !lstatSync(settingsPath).isSymbolicLink()) {
        chmodSync(settingsPath, 0o600);
      }
    } catch {
      // ignore cleanup chmod errors
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("readSettingsDocument handles the full read-state matrix without throwing", async () => {
    const { readSettingsDocument, MAX_SETTINGS_BYTES } = await storeApi();

    // 1. missing
    expect(readSettingsDocument()).toEqual({ doc: {}, state: "missing" });
    const createdByLegacy = loadUserSettings();
    expect(createdByLegacy.createdDefaults).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    }

    // 2. ok (plain object, deeply nested, and UTF-8 BOM)
    const nested = { a: { b: { c: { d: [1, "two", true, null] } } }, thinking: false };
    writeFileSync(settingsPath, "\uFEFF" + JSON.stringify(nested), "utf-8");
    expect(readSettingsDocument()).toEqual({ doc: nested, state: "ok" });

    // 3. corrupt: empty, whitespace, invalid JSON, array, null, number, string, boolean, invalid UTF-8
    for (const badContent of ["", "   \n\t  ", "{not-json", "[1, 2, 3]", "null", "42", '"hello"', "true"]) {
      writeFileSync(settingsPath, badContent, "utf-8");
      const res = readSettingsDocument();
      expect(res.state).toBe("corrupt");
      expect(res.doc).toEqual({});
      expect(res.error).toBeDefined();
    }

    writeFileSync(settingsPath, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]));
    expect(readSettingsDocument().state).toBe("corrupt");

    // 4. unreadable: over 1 MB (1,048,576 bytes)
    const exactCapPayload = JSON.stringify({ pad: "x".repeat(MAX_SETTINGS_BYTES - 20) });
    expect(Buffer.byteLength(exactCapPayload, "utf8")).toBeLessThanOrEqual(MAX_SETTINGS_BYTES);
    writeFileSync(settingsPath, exactCapPayload, "utf-8");
    expect(readSettingsDocument().state).toBe("ok");

    const overCapPayload = JSON.stringify({ pad: "x".repeat(MAX_SETTINGS_BYTES) });
    expect(Buffer.byteLength(overCapPayload, "utf8")).toBeGreaterThan(MAX_SETTINGS_BYTES);
    writeFileSync(settingsPath, overCapPayload, "utf-8");
    const overRes = readSettingsDocument();
    expect(overRes.state).toBe("unreadable");
    expect(overRes.error).toMatch(/exceeds|size|1048576/i);

    // 5. unreadable: directory at settings.json
    rmSync(settingsPath, { force: true });
    mkdirSync(settingsPath);
    expect(readSettingsDocument().state).toBe("unreadable");
    rmSync(settingsPath, { recursive: true, force: true });

    // 6. symlink: link to regular file is ok; dangling symlink is unreadable
    if (process.platform !== "win32") {
      const targetFile = join(root, "outside.json");
      writeFileSync(targetFile, '{"thinking":true}', "utf-8");
      symlinkSync(targetFile, settingsPath);
      expect(readSettingsDocument()).toEqual({ doc: { thinking: true }, state: "ok" });
      rmSync(settingsPath, { force: true });

      symlinkSync(join(root, "dangling-target.json"), settingsPath);
      expect(readSettingsDocument().state).toBe("unreadable");
      rmSync(settingsPath, { force: true });
    }

    // 7. unreadable: permission denied (EACCES)
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      writeFileSync(settingsPath, '{"thinking":true}', { mode: 0o000 });
      chmodSync(settingsPath, 0o000);
      expect(readSettingsDocument().state).toBe("unreadable");
      chmodSync(settingsPath, 0o600);
    }
  });

  test("preserves unknown keys, default_model, config_overrides, and key order across store and legacy updates; null removes a key", async () => {
    const { readSettingsDocument, updateSettingsDocument } = await storeApi();

    const initialDoc = {
      custom_str: "keep-me",
      custom_num: 99,
      custom_bool: true,
      custom_null: null,
      custom_arr: [1, { nested: "ok" }],
      custom_obj: { deep: { flag: true } },
      default_model: { provider: "anthropic", model: "claude-sonnet-4-20250514", reasoning: "high" },
      config_overrides: { "edit.confirm": true, "turn.pause_after_steps": 40 },
      thinking: true,
      debug: false,
      removable: "will-be-removed",
    };
    writeFileSync(settingsPath, JSON.stringify(initialDoc, null, 2) + "\n", "utf-8");

    // 1. updateSettingsDocument sparse patch + null key removal
    const step1 = updateSettingsDocument({ debug: true, removable: null, added_key: "new" });
    expect(step1.ok).toBe(true);
    const afterStep1 = readSettingsDocument();
    expect(afterStep1.state).toBe("ok");
    expect(afterStep1.doc. removable).toBeUndefined();
    expect("removable" in afterStep1.doc).toBe(false);
    expect(afterStep1.doc.debug).toBe(true);
    expect(afterStep1.doc.added_key).toBe("new");
    expect(afterStep1.doc.custom_arr).toEqual(initialDoc.custom_arr);
    expect(afterStep1.doc.default_model).toEqual(initialDoc.default_model);
    expect(afterStep1.doc.config_overrides).toEqual(initialDoc.config_overrides);
    expect(Object.keys(afterStep1.doc).slice(0, 8)).toEqual(Object.keys(initialDoc).slice(0, 8));

    // 2. updateUserSettings sparse patch preserves unknown keys and concurrent legacy keys
    const step2 = updateUserSettings({ incognito: true });
    expect(step2.ok).toBe(true);
    const afterStep2 = readSettingsDocument();
    expect(afterStep2.doc.incognito).toBe(true);
    expect(afterStep2.doc.debug).toBe(true);
    expect(afterStep2.doc.custom_obj).toEqual(initialDoc.custom_obj);
    expect(afterStep2.doc.default_model).toEqual(initialDoc.default_model);
    expect(afterStep2.doc.config_overrides).toEqual(initialDoc.config_overrides);

    // 3. saveUserSettings replaces only the 7 legacy keys and preserves everything else
    const step3 = saveUserSettings({ ...DEFAULT_USER_SETTINGS, model: "gpt-4o", provider: "openai" });
    expect(step3.ok).toBe(true);
    const afterStep3 = readSettingsDocument();
    expect(afterStep3.doc.model).toBe("gpt-4o");
    expect(afterStep3.doc.provider).toBe("openai");
    expect(afterStep3.doc.custom_str).toBe("keep-me");
    expect(afterStep3.doc.default_model).toEqual(initialDoc.default_model);
    expect(afterStep3.doc.config_overrides).toEqual(initialDoc.config_overrides);

    // 4. resetUserSettings resets only the 7 legacy keys and preserves default_model, config_overrides, and unknown keys
    const step4 = resetUserSettings();
    expect(step4.ok).toBe(true);
    const afterStep4 = readSettingsDocument();
    expect(afterStep4.doc.model).toBe("");
    expect(afterStep4.doc.provider).toBe("");
    expect(afterStep4.doc.thinking).toBe(true);
    expect(afterStep4.doc.custom_str).toBe("keep-me");
    expect(afterStep4.doc.default_model).toEqual(initialDoc.default_model);
    expect(afterStep4.doc.config_overrides).toEqual(initialDoc.config_overrides);
  });

  test("corrupt and unreadable files are never overwritten by update/save; reset backs up corrupt files as 0600 and refuses unreadable files", async () => {
    const { updateSettingsDocument, replaceSettingsDocument, createSettingsFs, MAX_SETTINGS_BYTES } = await storeApi();

    const corruptBytes = "{corrupt-json-do-not-clobber";
    writeFileSync(settingsPath, corruptBytes, "utf-8");

    expect(updateSettingsDocument({ thinking: false }).ok).toBe(false);
    expect(readFileSync(settingsPath, "utf-8")).toBe(corruptBytes);

    expect(updateUserSettings({ thinking: false }).ok).toBe(false);
    expect(readFileSync(settingsPath, "utf-8")).toBe(corruptBytes);

    expect(saveUserSettings(DEFAULT_USER_SETTINGS).ok).toBe(false);
    expect(readFileSync(settingsPath, "utf-8")).toBe(corruptBytes);

    // If backup write fails, original corrupt file is untouched and reset returns error.
    const defaultFsForBackup = createSettingsFs();
    const failingBackupFs = createSettingsFs({
      openExclusive(p, mode) {
        if (p.includes(".corrupt-")) {
          throw new Error("backup disk full");
        }
        return defaultFsForBackup.openExclusive(p, mode);
      },
    });
    const failedReset = replaceSettingsDocument({ ...DEFAULT_USER_SETTINGS }, { fs: failingBackupFs, backupCorrupt: true });
    expect(failedReset.ok).toBe(false);
    expect(readFileSync(settingsPath, "utf-8")).toBe(corruptBytes);

    // Normal resetUserSettings backs up the corrupt file (unique name, 0600) and writes defaults.
    const reset = resetUserSettings();
    expect(reset.ok).toBe(true);
    const files = readdirSync(homeDir);
    const backups = files.filter((f) => f.startsWith("settings.json.corrupt-"));
    expect(backups).toHaveLength(1);
    const backupFile = join(homeDir, backups[0] ?? "");
    expect(readFileSync(backupFile, "utf-8")).toBe(corruptBytes);
    if (process.platform !== "win32") {
      expect(statSync(backupFile).mode & 0o777).toBe(0o600);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(DEFAULT_USER_SETTINGS);

    // Unreadable files (directory, symlink, oversized) are NEVER replaced even by resetUserSettings or replaceSettingsDocument.
    rmSync(settingsPath, { force: true });
    mkdirSync(settingsPath);
    expect(resetUserSettings().ok).toBe(false);
    expect(replaceSettingsDocument({ thinking: true }).ok).toBe(false);
    expect(lstatSync(settingsPath).isDirectory()).toBe(true);
    rmSync(settingsPath, { recursive: true, force: true });

    if (process.platform !== "win32") {
      // Unreadable symlinks (dangling, directory, loop) are NEVER replaced even by resetUserSettings or replaceSettingsDocument.
      const danglingTarget = join(root, "dangling-target-unreadable.json");
      symlinkSync(danglingTarget, settingsPath);
      expect(updateUserSettings({ thinking: false }).ok).toBe(false);
      expect(saveUserSettings(DEFAULT_USER_SETTINGS).ok).toBe(false);
      expect(resetUserSettings().ok).toBe(false);
      expect(replaceSettingsDocument({ thinking: true }).ok).toBe(false);
      expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(existsSync(danglingTarget)).toBe(false);
      rmSync(settingsPath, { force: true });
    }

    // Refuses to write a document exceeding MAX_SETTINGS_BYTES without touching existing file
    const originalValid = '{"thinking":true}\n';
    writeFileSync(settingsPath, originalValid, "utf-8");
    const hugeWrite = updateSettingsDocument({ huge: "x".repeat(MAX_SETTINGS_BYTES + 100) });
    expect(hugeWrite.ok).toBe(false);
    expect(readFileSync(settingsPath, "utf-8")).toBe(originalValid);
  });

  test("filesystem seam exposes the 12 operations, enforces 0600 permissions, closes descriptors, and preserves original bytes on failure", async () => {
    const { createSettingsFs, updateSettingsDocument, replaceSettingsDocument } = await storeApi();

    const defaultFs = createSettingsFs();
    expect(Object.keys(defaultFs).sort()).toEqual([
      "chmod",
      "close",
      "copyFile",
      "fsync",
      "fsyncDir",
      "lstat",
      "openExclusive",
      "readBounded",
      "realpath",
      "rename",
      "unlink",
      "write",
    ]);

    // Pre-existing 0644 file becomes 0600 after update and replace; every touched path is inside root.
    const touchedPaths: string[] = [];
    const trackingFs = createSettingsFs({
      openExclusive(p, mode) {
        touchedPaths.push(p);
        return defaultFs.openExclusive(p, mode);
      },
      lstat(p) {
        touchedPaths.push(p);
        return defaultFs.lstat(p);
      },
      rename(oldP, newP) {
        touchedPaths.push(oldP, newP);
        return defaultFs.rename(oldP, newP);
      },
    });

    writeFileSync(settingsPath, '{"thinking":true}\n', { mode: 0o644 });
    if (process.platform !== "win32") {
      chmodSync(settingsPath, 0o644);
      expect(statSync(settingsPath).mode & 0o777).toBe(0o644);
    }

    expect(updateSettingsDocument({ debug: true }, { fs: trackingFs }).ok).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(settingsPath).mode & 0o777).toBe(0o600);
    }

    // Verify isolation: every path touched by the store is inside the test PRAANA_HOME.
    expect(touchedPaths.length).toBeGreaterThan(0);
    for (const p of touchedPaths) {
      const rel = relative(root, p);
      expect(rel.startsWith("..")).toBe(false);
    }

    const savedBytes = readFileSync(settingsPath, "utf-8");

    // Inject failures at write, fsync, and rename; verify fd closed, no temp files left, and original bytes intact.
    for (const failPoint of ["write", "fsync", "rename"] as const) {
      const openFds = new Set<number>();
      let closedBeforeRename = false;
      const seamFs = createSettingsFs({
        openExclusive(p, mode) {
          const fd = defaultFs.openExclusive(p, mode);
          openFds.add(fd);
          return fd;
        },
        write(fd, data) {
          if (failPoint === "write") throw new Error("injected write failure");
          return defaultFs.write(fd, data);
        },
        fsync(fd) {
          if (failPoint === "fsync") throw new Error("injected fsync failure");
          return defaultFs.fsync(fd);
        },
        close(fd) {
          openFds.delete(fd);
          return defaultFs.close(fd);
        },
        rename(oldP, newP) {
          closedBeforeRename = openFds.size === 0;
          if (failPoint === "rename") throw new Error("injected rename failure");
          return defaultFs.rename(oldP, newP);
        },
      });

      const res = updateSettingsDocument({ theme: `fail-${failPoint}` }, { fs: seamFs });
      expect(res.ok).toBe(false);
      expect(openFds.size).toBe(0);
      if (failPoint === "rename") expect(closedBeforeRename).toBe(true);
      expect(readFileSync(settingsPath, "utf-8")).toBe(savedBytes);
      const leftovers = readdirSync(homeDir).filter((f) => f.includes(".tmp-"));
      expect(leftovers).toEqual([]);
    }

    // Verify closedBeforeRename on a successful replace as well
    let closedOnSuccess = false;
    const openSet = new Set<number>();
    const successFs = createSettingsFs({
      openExclusive(p, mode) {
        const fd = defaultFs.openExclusive(p, mode);
        openSet.add(fd);
        return fd;
      },
      close(fd) {
        openSet.delete(fd);
        return defaultFs.close(fd);
      },
      rename(oldP, newP) {
        closedOnSuccess = openSet.size === 0;
        return defaultFs.rename(oldP, newP);
      },
    });
    expect(replaceSettingsDocument({ ...DEFAULT_USER_SETTINGS }, { fs: successFs }).ok).toBe(true);
    expect(closedOnSuccess).toBe(true);
  });

  test("loadSettingsFile reports per-key invalidKeys, ignoredUnknownKeys, rejectedOverrides, and warnings", async () => {
    const { loadSettingsFile, parseDefaultModel } = await storeApi();

    expect(parseDefaultModel(undefined)).toEqual({ value: null, errors: [] });
    expect(parseDefaultModel("bad")).toEqual({
      value: null,
      errors: [{ key: "default_model", reason: expect.stringMatching(/plain object/i) }],
    });
    expect(parseDefaultModel({ provider: "", model: "gpt-4o", reasoning: "invalid", extra: 1 })).toEqual({
      value: null,
      errors: [
        { key: "default_model.provider", reason: expect.any(String) },
        { key: "default_model.reasoning", reason: expect.any(String) },
        { key: "default_model.extra", reason: expect.any(String) },
      ],
    });
    expect(parseDefaultModel({ provider: "openai", model: "gpt-4o", reasoning: "high" })).toEqual({
      value: { provider: "openai", model: "gpt-4o", reasoning: "high" },
      errors: [],
    });

    const doc = {
      thinking: "not-a-bool",
      theme: "",
      debug: true,
      default_model: { provider: "anthropic", model: "" },
      config_overrides: {
        "edit.confirm": true,
        "risk.allow": ["rm"],
        "turn.pause_after_steps": 9999,
      },
      mystery_one: 123,
      mystery_two: { a: 1 },
    };
    writeFileSync(settingsPath, JSON.stringify(doc), "utf-8");

    const loaded = loadSettingsFile();
    expect(loaded.state).toBe("ok");
    expect(loaded.settings.debug).toBe(true);
    expect(loaded.settings.thinking).toBe(DEFAULT_USER_SETTINGS.thinking);
    expect(loaded.defaultModel).toBeNull();
    expect(loaded.configOverrides).toEqual({ "edit.confirm": true });
    expect(loaded.ignoredUnknownKeys).toEqual(["mystery_one", "mystery_two"]);
    expect(loaded.invalidKeys.map((k) => k.key)).toEqual(["thinking", "theme", "default_model.model"]);
    expect(loaded.rejectedOverrides.map((r) => r.path)).toEqual(["risk.allow", "turn.pause_after_steps"]);
    expect(loaded.warnings.length).toBeGreaterThanOrEqual(5);

    // Non-object config_overrides yields a warning and no overrides
    writeFileSync(settingsPath, JSON.stringify({ config_overrides: ["bad"] }), "utf-8");
    const nonObj = loadSettingsFile();
    expect(nonObj.configOverrides).toEqual({});
    expect(nonObj.invalidKeys.map((k) => k.key)).toContain("config_overrides");
    expect(nonObj.warnings.length).toBeGreaterThan(0);

    // Legacy resolver consumer still reads provider/model pair
    saveUserSettings({ ...DEFAULT_USER_SETTINGS, provider: "ollama", model: "custom-ollama-model" });
    const resolved = resolveActiveModelAndProvider();
    expect(resolved.provider).toBe("ollama");
    expect(resolved.model).toBe("custom-ollama-model");
  });

  test("multi-process concurrency: sequential barrier phases preserve cross-process legacy & store keys, and overlapping writers never produce torn JSON", async () => {
    await storeApi();
    const scratchDir = join( process.env.HOME ?? tmpdir(), ".cache", "settings-scratch");
    mkdirSync(scratchDir, { recursive: true });
    const workerScript = join(scratchDir, `settings-worker-${process.pid}.ts`);
    const testDir = dirname(fileURLToPath(import.meta.url));
    const storeModulePath = join(dirname(testDir), "src", "settings", "store.ts");
    const userSettingsModulePath = join(dirname(testDir), "src", "user-settings.ts");

    writeFileSync(
      workerScript,
      `
import { existsSync, writeFileSync } from "node:fs";
import { updateSettingsDocument } from ${JSON.stringify(storeModulePath)};
import { updateUserSettings } from ${JSON.stringify(userSettingsModulePath)};

const [mode, id, barrierPath, doneFlagPath] = process.argv.slice(2);
console.log("READY:" + id);

while (!existsSync(barrierPath)) {
  Bun.sleepSync(2);
}

if (mode === "sequential-a") {
  const r1 = updateUserSettings({ model: "model-from-a" });
  const r2 = updateSettingsDocument({ key_a: "val-a" });
  if (!r1.ok || !r2.ok) process.exit(2);
  writeFileSync(doneFlagPath, "done");
  console.log("DONE:" + id + ":2");
} else if (mode === "sequential-b") {
  const r1 = updateUserSettings({ provider: "provider-from-b" });
  const r2 = updateSettingsDocument({ key_b: "val-b" });
  if (!r1.ok || !r2.ok) process.exit(2);
  writeFileSync(doneFlagPath, "done");
  console.log("DONE:" + id + ":2");
} else if (mode === "overlap-diff") {
  let count = 0;
  for (let i = 0; i < 25; i++) {
    const res = updateSettingsDocument({ ["worker_" + id]: "iter-" + i, ["worker_" + id + "_" + i]: i });
    if (!res.ok) process.exit(3);
    count++;
    Bun.sleepSync(2);
  }
  console.log("DONE:" + id + ":" + count);
} else if (mode === "overlap-same") {
  let count = 0;
  for (let i = 0; i < 25; i++) {
    const res = updateSettingsDocument({ shared_key: "from-" + id + "-" + i });
    if (!res.ok) process.exit(4);
    count++;
    Bun.sleepSync(2);
  }
  console.log("DONE:" + id + ":" + count);
}
`,
      "utf-8",
    );

    try {
      // Phase 1: Sequential acknowledged phases across two child processes (including two different legacy keys via updateUserSettings)
      const barrierA = join(root, "barrier-a");
      const doneA = join(root, "done-a");
      const barrierB = join(root, "barrier-b");
      const doneB = join(root, "done-b");

      const procA = Bun.spawn(["bun", workerScript, "sequential-a", "A", barrierA, doneA], {
        env: { ...process.env, PRAANA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const procB = Bun.spawn(["bun", workerScript, "sequential-b", "B", barrierB, doneB], {
        env: { ...process.env, PRAANA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });

      writeFileSync(barrierA, "go");
      expect(await procA.exited).toBe(0);
      expect(await new Response(procA.stdout).text()).toContain("DONE:A:2");

      const afterA = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(afterA.model).toBe("model-from-a");
      expect(afterA.key_a).toBe("val-a");

      writeFileSync(barrierB, "go");
      expect(await procB.exited).toBe(0);
      expect(await new Response(procB.stdout).text()).toContain("DONE:B:2");

      const afterB = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(afterB.model).toBe("model-from-a");
      expect(afterB.provider).toBe("provider-from-b");
      expect(afterB.key_a).toBe("val-a");
      expect(afterB.key_b).toBe("val-b");

      // Phase 2: True-overlap writers updating different keys while parent samples the file
      const overlapBarrier = join(root, "barrier-overlap");
      const w1 = Bun.spawn(["bun", workerScript, "overlap-diff", "W1", overlapBarrier, ""], {
        env: { ...process.env, PRAANA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const w2 = Bun.spawn(["bun", workerScript, "overlap-diff", "W2", overlapBarrier, ""], {
        env: { ...process.env, PRAANA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });

      writeFileSync(overlapBarrier, "go");
      let samplesDuringActivity = 0;
      let done = false;
      void Promise.all([w1.exited, w2.exited]).then(() => {
        done = true;
      });

      while (!done) {
        if (existsSync(settingsPath)) {
          const raw = readFileSync(settingsPath, "utf-8");
          const parsed = JSON.parse(raw);
          expect(typeof parsed).toBe("object");
          samplesDuringActivity++;
        }
        await Bun.sleep(1);
      }
      expect(await w1.exited).toBe(0);
      expect(await w2.exited).toBe(0);
      expect(samplesDuringActivity).toBeGreaterThan(0);

      // Final sequential round to verify both workers' final sequential write sticks
      const { updateSettingsDocument } = await storeApi();
      expect(updateSettingsDocument({ worker_W1: "final-W1" }).ok).toBe(true);
      expect(updateSettingsDocument({ worker_W2: "final-W2" }).ok).toBe(true);
      const afterOverlap = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(afterOverlap.worker_W1).toBe("final-W1");
      expect(afterOverlap.worker_W2).toBe("final-W2");

      // Phase 3: Same-key overlap variant
      const sameBarrier = join(root, "barrier-same");
      const s1 = Bun.spawn(["bun", workerScript, "overlap-same", "S1", sameBarrier, ""], {
        env: { ...process.env, PRAANA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const s2 = Bun.spawn(["bun", workerScript, "overlap-same", "S2", sameBarrier, ""], {
        env: { ...process.env, PRAANA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      writeFileSync(sameBarrier, "go");
      expect(await s1.exited).toBe(0);
      expect(await s2.exited).toBe(0);
      const finalSame = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(finalSame.shared_key).toMatch(/^from-(S1|S2)-\d+$/);
    } finally {
      rmSync(workerScript, { force: true });
    }
  });

  test("concurrent child processes patching distinct keys 50 times each preserve every key", async () => {
    await storeApi();
    const scratchDir = join(process.env.HOME ?? tmpdir(), ".cache", "settings-scratch");
    mkdirSync(scratchDir, { recursive: true });
    const workerScript = join(scratchDir, `settings-race-worker-${process.pid}.ts`);
    const testDir = dirname(fileURLToPath(import.meta.url));
    const storeModulePath = join(dirname(testDir), "src", "settings", "store.ts");

    writeFileSync(
      workerScript,
      `
import { existsSync } from "node:fs";
import { updateSettingsDocument } from ${JSON.stringify(storeModulePath)};

const [id, barrierPath] = process.argv.slice(2);
console.log("READY:" + id);
while (!existsSync(barrierPath)) {
  Bun.sleepSync(1);
}
for (let i = 0; i < 50; i++) {
  const res = updateSettingsDocument({ [id + "_" + i]: i });
  if (!res.ok) {
    console.error("FAIL:" + id + ":" + i + ":" + res.error);
    process.exit(2);
  }
}
`,
      "utf-8",
    );

    const waitForReady = async (stdout: ReadableStream<Uint8Array>, expected: string) => {
      const reader = stdout.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!buf.includes(expected)) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
      }
      reader.releaseLock();
      expect(buf).toContain(expected);
    };

    try {
      const barrier = join(root, "race-barrier");
      const p1 = Bun.spawn(["bun", workerScript, "p1", barrier], {
        env: { ...process.env, PRAANA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const p2 = Bun.spawn(["bun", workerScript, "p2", barrier], {
        env: { ...process.env, PRAANA_HOME: root },
        stdout: "pipe",
        stderr: "pipe",
      });

      await Promise.all([
        waitForReady(p1.stdout, "READY:p1"),
        waitForReady(p2.stdout, "READY:p2"),
      ]);

      writeFileSync(barrier, "go");
      expect(await p1.exited).toBe(0);
      expect(await p2.exited).toBe(0);

      const finalDoc = JSON.parse(readFileSync(settingsPath, "utf-8"));
      for (let i = 0; i < 50; i++) {
        expect(finalDoc[`p1_${i}`]).toBe(i);
        expect(finalDoc[`p2_${i}`]).toBe(i);
      }
    } finally {
      rmSync(workerScript, { force: true });
    }
  });

  test("rejects __proto__, constructor, and prototype keys in update/replace before any write, and JSON.parse read path cannot poison prototypes", async () => {
    const {
      readSettingsDocument,
      updateSettingsDocument,
      replaceSettingsDocument,
      loadSettingsFile,
    } = await storeApi();

    const baseline = JSON.stringify({ thinking: true }, null, 2) + "\n";
    writeFileSync(settingsPath, baseline, "utf-8");

    for (const forbiddenKey of ["__proto__", "constructor", "prototype"] as const) {
      const hostilePatch = JSON.parse(`{"${forbiddenKey}": {"polluted": "yes"}, "debug": true}`) as Record<
        string,
        unknown
      >;
      const updateRes = updateSettingsDocument(hostilePatch);
      expect(updateRes.ok).toBe(false);
      if (!updateRes.ok) {
        expect(updateRes.error).toContain(forbiddenKey);
      }
      expect(readFileSync(settingsPath, "utf-8")).toBe(baseline);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();

      const hostileNullPatch = JSON.parse(`{"${forbiddenKey}": null}`) as Record<string, unknown>;
      expect(updateSettingsDocument(hostileNullPatch).ok).toBe(false);
      expect(readFileSync(settingsPath, "utf-8")).toBe(baseline);

      const hostileDoc = JSON.parse(`{"${forbiddenKey}": {"polluted": "yes"}, "thinking": false}`) as Record<
        string,
        unknown
      >;
      const replaceRes = replaceSettingsDocument(hostileDoc);
      expect(replaceRes.ok).toBe(false);
      if (!replaceRes.ok) {
        expect(replaceRes.error).toContain(forbiddenKey);
      }
      expect(readFileSync(settingsPath, "utf-8")).toBe(baseline);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }

    // Object literal with mutated prototype (not an own key) is also rejected.
    const protoMutated = { __proto__: { polluted: "yes" } } as unknown as Record<string, unknown>;
    expect(updateSettingsDocument(protoMutated).ok).toBe(false);
    expect(replaceSettingsDocument(protoMutated).ok).toBe(false);
    expect(readFileSync(settingsPath, "utf-8")).toBe(baseline);

    // Confirm JSON.parse of a file on disk containing __proto__/constructor/prototype cannot poison the read path.
    writeFileSync(
      settingsPath,
      '{"__proto__": {"polluted": "yes"}, "constructor": {"bad": 1}, "prototype": {"bad": 2}, "thinking": false}\n',
      "utf-8",
    );
    const readRes = readSettingsDocument();
    expect(readRes.state).toBe("ok");
    expect(Object.getPrototypeOf(readRes.doc)).toBe(Object.prototype);
    expect((readRes.doc as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();

    const loaded = loadSettingsFile();
    expect(loaded.state).toBe("ok");
    expect(loaded.settings.thinking).toBe(false);
    expect(loaded.ignoredUnknownKeys).toEqual(["__proto__", "constructor", "prototype"]);

    const legacyLoaded = loadUserSettings();
    expect(legacyLoaded.settings.thinking).toBe(false);
  });

  test("corrupt backup is created exclusively with 0600 mode (no copyFile + post-chmod window)", async () => {
    const { createSettingsFs, replaceSettingsDocument } = await storeApi();
    const defaultFs = createSettingsFs();

    const corruptBytes = "{corrupt-secret-content";
    writeFileSync(settingsPath, corruptBytes, { mode: 0o644 });
    if (process.platform !== "win32") {
      chmodSync(settingsPath, 0o644);
    }

    let copyFileCalled = false;
    let backupOpenMode: number | undefined;
    let backupModeDuringWrite: number | undefined;
    let backupWrittenBytes: Buffer | undefined;

    const spyFs = createSettingsFs({
      copyFile(src, dest) {
        copyFileCalled = true;
        return defaultFs.copyFile(src, dest);
      },
      openExclusive(p, mode) {
        if (p.includes(".corrupt-")) {
          backupOpenMode = mode;
        }
        return defaultFs.openExclusive(p, mode);
      },
      write(fd, data) {
        const files = readdirSync(homeDir).filter((f) => f.startsWith("settings.json.corrupt-"));
        if (files.length === 1 && backupModeDuringWrite === undefined) {
          backupModeDuringWrite = statSync(join(homeDir, files[0] ?? "")).mode & 0o777;
          backupWrittenBytes = Buffer.from(data);
        }
        return defaultFs.write(fd, data);
      },
    });

    const res = replaceSettingsDocument({ ...DEFAULT_USER_SETTINGS }, { fs: spyFs, backupCorrupt: true });
    expect(res.ok).toBe(true);
    expect(copyFileCalled).toBe(false);
    expect(backupOpenMode).toBe(0o600);
    expect(backupWrittenBytes?.toString("utf-8")).toBe(corruptBytes);
    if (process.platform !== "win32") {
      expect(backupModeDuringWrite).toBe(0o600);
      if (res.ok && res.backupPath) {
        expect(statSync(res.backupPath).mode & 0o777).toBe(0o600);
      }
    }
  });

  test("readBounded / readSettingsDocument rejects real FIFO without blocking even when lstat reports a regular file", async () => {
    if (process.platform === "win32") return;
    const mkfifo = Bun.spawnSync(["mkfifo", settingsPath]);
    if (mkfifo.exitCode !== 0) return;

    const { readSettingsDocument } = await storeApi();
    // Direct read sees FIFO at lstat and returns unreadable.
    expect(readSettingsDocument().state).toBe("unreadable");

    // Simulated TOCTOU race: lstat claims regular file, underlying path is a real FIFO.
    const testDir = dirname(fileURLToPath(import.meta.url));
    const storeModulePath = join(dirname(testDir), "src", "settings", "store.ts");
    const scratchDir = join(process.env.HOME ?? tmpdir(), ".cache", "settings-scratch");
    mkdirSync(scratchDir, { recursive: true });
    const fifoScript = join(scratchDir, `settings-fifo-race-${process.pid}.ts`);

    writeFileSync(
      fifoScript,
      `
import type { Stats } from "node:fs";
import { createSettingsFs, readSettingsDocument } from ${JSON.stringify(storeModulePath)};

const settingsPath = process.argv[2];
const raceFs = createSettingsFs({
  lstat() {
    return {
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true,
    } as unknown as Stats;
  },
});
const res = readSettingsDocument({ path: settingsPath, fs: raceFs });
console.log(JSON.stringify(res));
`,
      "utf-8",
    );

    try {
      const proc = Bun.spawn(["bun", fifoScript, settingsPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const timeoutMs = 1_000;
      const outcome = await Promise.race([
        proc.exited.then((code) => ({ kind: "exit" as const, code })),
        Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
      ]);
      if (outcome.kind === "timeout") {
        proc.kill();
        await proc.exited;
      }
      expect(outcome.kind).toBe("exit");
      if (outcome.kind === "exit") {
        expect(outcome.code).toBe(0);
        const stdout = await new Response(proc.stdout).text();
        const parsed = JSON.parse(stdout.trim()) as { state: string };
        expect(parsed.state).toBe("unreadable");
      }
    } finally {
      rmSync(fifoScript, { force: true });
    }
  });

  test("readSettingsDocument opens with O_NOFOLLOW | O_NONBLOCK and rejects FIFO-like fd via injectable fs", async () => {
    const { constants } = await import("node:fs");
    const { createSettingsFs, readSettingsDocument } = await storeApi();

    let observedFlags = 0;
    let readCalled = false;
    let closedFd: number | undefined;
    const fakeFd = 4242;

    const fifoRaceFs = createSettingsFs(
      {
        lstat() {
          return {
            isSymbolicLink: () => false,
            isDirectory: () => false,
            isFile: () => true,
          } as unknown as import("node:fs").Stats;
        },
      },
      {
        open(_p, flags) {
          observedFlags = flags;
          return fakeFd;
        },
        fstat(fd) {
          expect(fd).toBe(fakeFd);
          return {
            isDirectory: () => false,
            isFile: () => false,
            isFIFO: () => true,
          } as unknown as import("node:fs").Stats;
        },
        read() {
          readCalled = true;
          return 0;
        },
        close(fd) {
          closedFd = fd;
        },
      },
    );

    const res = readSettingsDocument({ path: settingsPath, fs: fifoRaceFs });
    expect(res.state).toBe("unreadable");
    expect(res.error).toMatch(/not a regular file/i);
    if (constants.O_NOFOLLOW !== undefined) {
      expect((observedFlags & constants.O_NOFOLLOW) !== 0).toBe(true);
    }
    if (constants.O_NONBLOCK !== undefined) {
      expect((observedFlags & constants.O_NONBLOCK) !== 0).toBe(true);
    }
    expect(readCalled).toBe(false);
    expect(closedFd).toBe(fakeFd);
  });

  test("updateSettingsDocument supports createOnly and onCorrupt backup-and-reset-legacy inside the lock", async () => {
    const { updateSettingsDocument, createSettingsFs } = await storeApi();
    const baseFs = createSettingsFs();

    // createOnly creates when missing and reports created: true
    const created = updateSettingsDocument(
      { extra: "ignored-only-not-used" },
      { baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS }, createOnly: true },
    );
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.created).toBe(true);
      expect(created.doc.extra).toBe("ignored-only-not-used");
    }

    // createOnly on existing valid file returns existing doc without writing and reports created: false
    let renameCalls = 0;
    const spyFs = createSettingsFs({
      rename(oldPath, newPath) {
        renameCalls++;
        return baseFs.rename(oldPath, newPath);
      },
    });
    const existing = updateSettingsDocument(
      { thinking: false },
      { fs: spyFs, baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS }, createOnly: true },
    );
    expect(existing.ok).toBe(true);
    if (existing.ok) {
      expect(existing.created).toBe(false);
      expect(existing.doc.thinking).toBe(true);
    }
    expect(renameCalls).toBe(0);

    // onCorrupt: "backup-and-reset-legacy" backs up corrupt bytes with 0600 and writes defaults
    writeFileSync(settingsPath, "{corrupt-on-disk", "utf-8");
    const resetCorrupt = updateSettingsDocument(
      { ...DEFAULT_USER_SETTINGS },
      { baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS }, onCorrupt: "backup-and-reset-legacy" },
    );
    expect(resetCorrupt.ok).toBe(true);
    if (resetCorrupt.ok) {
      expect(resetCorrupt.backupPath).toBeDefined();
      expect(readFileSync(resetCorrupt.backupPath!, "utf-8")).toBe("{corrupt-on-disk");
      if (process.platform !== "win32") {
        expect(statSync(resetCorrupt.backupPath!).mode & 0o777).toBe(0o600);
      }
    }
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(DEFAULT_USER_SETTINGS);

    // onCorrupt: "backup-and-reset-legacy" on valid file preserves default_model/config_overrides/unknown keys without backup
    writeFileSync(
      settingsPath,
      JSON.stringify({
        thinking: false,
        default_model: { provider: "openai", model: "gpt-4o" },
        custom_key: "keep",
      }),
      "utf-8",
    );
    const resetValid = updateSettingsDocument(
      { ...DEFAULT_USER_SETTINGS },
      { baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS }, onCorrupt: "backup-and-reset-legacy" },
    );
    expect(resetValid.ok).toBe(true);
    if (resetValid.ok) {
      expect(resetValid.backupPath).toBeUndefined();
      expect(resetValid.doc.default_model).toEqual({ provider: "openai", model: "gpt-4o" });
      expect(resetValid.doc.custom_key).toBe("keep");
      expect(resetValid.doc.thinking).toBe(true);
    }
  });

  test("updateSettingsDocument with an empty patch on an existing valid file does not write or change mtime", async () => {
    const { updateSettingsDocument, createSettingsFs } = await storeApi();
    const baseFs = createSettingsFs();

    const initialDoc = { thinking: false, custom_key: "keep" };
    writeFileSync(settingsPath, JSON.stringify(initialDoc, null, 2) + "\n", "utf-8");
    const fixedTime = new Date(1_700_000_000_000);
    utimesSync(settingsPath, fixedTime, fixedTime);
    const mtimeBefore = statSync(settingsPath).mtimeMs;

    let openExclusiveCalls = 0;
    let renameCalls = 0;
    const spyFs = createSettingsFs({
      openExclusive(p, mode) {
        openExclusiveCalls++;
        return baseFs.openExclusive(p, mode);
      },
      rename(oldPath, newPath) {
        renameCalls++;
        return baseFs.rename(oldPath, newPath);
      },
    });

    const resEmpty = updateSettingsDocument({}, { fs: spyFs });
    expect(resEmpty.ok).toBe(true);
    if (resEmpty.ok) {
      expect(resEmpty.doc).toEqual(initialDoc);
      expect(resEmpty.created).toBe(false);
    }
    expect(openExclusiveCalls).toBe(0);
    expect(renameCalls).toBe(0);
    expect(statSync(settingsPath).mtimeMs).toBe(mtimeBefore);

    const resUndefinedOnly = updateSettingsDocument({ thinking: undefined }, { fs: spyFs });
    expect(resUndefinedOnly.ok).toBe(true);
    if (resUndefinedOnly.ok) {
      expect(resUndefinedOnly.doc).toEqual(initialDoc);
      expect(resUndefinedOnly.created).toBe(false);
    }
    expect(openExclusiveCalls).toBe(0);
    expect(renameCalls).toBe(0);
    expect(statSync(settingsPath).mtimeMs).toBe(mtimeBefore);

    // Empty patch still fails on a corrupt file.
    writeFileSync(settingsPath, "{corrupt", "utf-8");
    expect(updateSettingsDocument({}, { fs: spyFs }).ok).toBe(false);
    expect(openExclusiveCalls).toBe(0);
    expect(renameCalls).toBe(0);
  });

  test("writeDocumentAtomic and writeCorruptBackup close each fd exactly once even when close throws", async () => {
    const { updateSettingsDocument, replaceSettingsDocument, createSettingsFs } = await storeApi();
    const baseFs = createSettingsFs();

    // 1. writeDocumentAtomic (via updateSettingsDocument)
    writeFileSync(settingsPath, '{"thinking":true}\n', "utf-8");
    const atomicWriteFds = new Set<number>();
    let atomicCloseCalls = 0;
    const atomicCloseThrowFs = createSettingsFs({
      openExclusive(p, mode) {
        const fd = baseFs.openExclusive(p, mode);
        atomicWriteFds.add(fd);
        return fd;
      },
      close(fd) {
        if (atomicWriteFds.has(fd)) {
          atomicCloseCalls++;
          if (atomicCloseCalls === 1) {
            baseFs.close(fd);
            throw new Error("injected atomic close failure");
          }
          return;
        }
        baseFs.close(fd);
      },
    });
    const atomicRes = updateSettingsDocument({ debug: true }, { fs: atomicCloseThrowFs });
    expect(atomicRes.ok).toBe(false);
    expect(atomicCloseCalls).toBe(1);
    expect(readdirSync(homeDir).filter((f) => f.includes(".tmp-"))).toEqual([]);

    // 2. writeCorruptBackup (via replaceSettingsDocument on a corrupt file)
    writeFileSync(settingsPath, "{corrupt-bytes", "utf-8");
    const backupWriteFds = new Set<number>();
    let backupCloseCalls = 0;
    const backupCloseThrowFs = createSettingsFs({
      openExclusive(p, mode) {
        const fd = baseFs.openExclusive(p, mode);
        backupWriteFds.add(fd);
        return fd;
      },
      close(fd) {
        if (backupWriteFds.has(fd)) {
          backupCloseCalls++;
          if (backupCloseCalls === 1) {
            baseFs.close(fd);
            throw new Error("injected backup close failure");
          }
          return;
        }
        baseFs.close(fd);
      },
    });
    const backupRes = replaceSettingsDocument(
      { ...DEFAULT_USER_SETTINGS },
      { fs: backupCloseThrowFs, backupCorrupt: true },
    );
    expect(backupRes.ok).toBe(false);
    expect(backupCloseCalls).toBe(1);
    expect(readdirSync(homeDir).filter((f) => f.includes(".corrupt-"))).toEqual([]);
  });

  test("readBounded uses readSeam.close or closeSync and never invokes write-path overrides.close", async () => {
    const { readSettingsDocument, updateSettingsDocument, replaceSettingsDocument, createSettingsFs } =
      await storeApi();
    const baseFs = createSettingsFs();

    writeFileSync(settingsPath, '{"thinking":true}\n', "utf-8");

    let overrideCloseCalls = 0;
    const spyFs = createSettingsFs({
      close(fd) {
        overrideCloseCalls++;
        return baseFs.close(fd);
      },
    });

    // Read-only call must never invoke overrides.close
    expect(readSettingsDocument({ fs: spyFs }).state).toBe("ok");
    expect(overrideCloseCalls).toBe(0);

    // Update performs 1 read + 1 atomic write -> only 1 write-path close
    expect(updateSettingsDocument({ debug: true }, { fs: spyFs }).ok).toBe(true);
    expect(overrideCloseCalls).toBe(1);

    // Replace on corrupt performs 1 read + 1 backup write + 1 atomic write -> only 2 write-path closes
    writeFileSync(settingsPath, "{corrupt", "utf-8");
    expect(replaceSettingsDocument({ ...DEFAULT_USER_SETTINGS }, { fs: spyFs, backupCorrupt: true }).ok).toBe(
      true,
    );
    expect(overrideCloseCalls).toBe(3);
  });

  test("a throwing lock release does not replace a committed result", async () => {
    const { updateSettingsDocument, replaceSettingsDocument } = await storeApi();
    const lockMod = await import("../src/credential-lock.js");
    const realAcquireSync = lockMod.acquireSync;
    const spy = spyOn(lockMod, "acquireSync").mockImplementation((lockPath, opts) => {
      const lock = realAcquireSync(lockPath, opts);
      return {
        release() {
          lock.release();
          throw new Error("injected release failure");
        },
      };
    });

    try {
      const updated = updateSettingsDocument({ thinking: false });
      expect(updated.ok).toBe(true);
      if (updated.ok) expect(updated.doc.thinking).toBe(false);
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ thinking: false });

      const replaced = replaceSettingsDocument({ ...DEFAULT_USER_SETTINGS });
      expect(replaced.ok).toBe(true);
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(DEFAULT_USER_SETTINGS);

      // A failing result is still reported as a failure, not as an exception.
      writeFileSync(settingsPath, "{corrupt", "utf-8");
      expect(updateSettingsDocument({ thinking: true }).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("a throwing directory fsync after a committed rename stays a success", async () => {
    const { updateSettingsDocument, replaceSettingsDocument, createSettingsFs } = await storeApi();
    const throwingFs = createSettingsFs({
      fsyncDir() {
        throw new Error("injected fsyncDir failure");
      },
    });

    const replaced = replaceSettingsDocument({ ...DEFAULT_USER_SETTINGS }, { fs: throwingFs });
    expect(replaced.ok).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(DEFAULT_USER_SETTINGS);

    const updated = updateSettingsDocument({ thinking: false }, { fs: throwingFs });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.doc.thinking).toBe(false);
    expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
      ...DEFAULT_USER_SETTINGS,
      thinking: false,
    });
    // The rename committed, so the temp file is gone and nothing is left behind.
    expect(readdirSync(homeDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("createOnly never modifies an existing file in any read state", async () => {
    const { updateSettingsDocument, createSettingsFs } = await storeApi();
    const baseFs = createSettingsFs();
    let writes = 0;
    const spyFs = createSettingsFs({
      openExclusive(p, mode) {
        writes++;
        return baseFs.openExclusive(p, mode);
      },
    });
    const backups = () => readdirSync(homeDir).filter((f) => f.includes(".corrupt-"));

    // ok: the existing document is returned unchanged and nothing is written (bytes, inode, mtime intact).
    const existingDoc = { thinking: false, custom_key: "keep" };
    const existingBytes = '{"thinking":false,"custom_key":"keep"}\n';
    writeFileSync(settingsPath, existingBytes, "utf-8");
    const fixedTime = new Date(1_700_000_000_000);
    utimesSync(settingsPath, fixedTime, fixedTime);
    const statBefore = statSync(settingsPath);
    const existing = updateSettingsDocument(
      { thinking: true },
      { fs: spyFs, baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS }, createOnly: true },
    );
    expect(existing.ok).toBe(true);
    if (existing.ok) {
      expect(existing.created).toBe(false);
      expect(existing.doc).toEqual(existingDoc);
    }
    expect(writes).toBe(0);
    expect(readFileSync(settingsPath, "utf-8")).toBe(existingBytes);
    const statAfter = statSync(settingsPath);
    expect(statAfter.ino).toBe(statBefore.ino);
    expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);

    // corrupt: error with the state and underlying read error (no unreachable fallback), no write and no backup even when onCorrupt is set.
    const corruptBytes = "[1, 2, 3]";
    writeFileSync(settingsPath, corruptBytes, "utf-8");
    const corruptRes = updateSettingsDocument(
      { ...DEFAULT_USER_SETTINGS },
      {
        fs: spyFs,
        baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS },
        createOnly: true,
        onCorrupt: "backup-and-reset-legacy",
      },
    );
    expect(corruptRes.ok).toBe(false);
    if (!corruptRes.ok) {
      expect(corruptRes.state).toBe("corrupt");
      expect(corruptRes.error).toContain("root must be a JSON object");
      expect(corruptRes.error).not.toContain("it already exists");
    }
    expect(writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(readFileSync(settingsPath, "utf-8")).toBe(corruptBytes);

    // unreadable: error with the state, no write and no backup.
    rmSync(settingsPath, { force: true });
    mkdirSync(settingsPath);
    const unreadableRes = updateSettingsDocument(
      { ...DEFAULT_USER_SETTINGS },
      { fs: spyFs, createOnly: true, onCorrupt: "backup-and-reset-legacy" },
    );
    expect(unreadableRes.ok).toBe(false);
    if (!unreadableRes.ok) expect(unreadableRes.state).toBe("unreadable");
    expect(writes).toBe(0);
    expect(backups()).toEqual([]);
    expect(lstatSync(settingsPath).isDirectory()).toBe(true);
    rmSync(settingsPath, { recursive: true, force: true });

    // missing: still creates the file and reports created: true.
    const created = updateSettingsDocument(
      {},
      { fs: spyFs, baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS }, createOnly: true },
    );
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.created).toBe(true);
    expect(writes).toBe(1);
  });

  test("a failed replacement write removes the corrupt backup it just created and keeps the corrupt file", async () => {
    const { updateSettingsDocument, replaceSettingsDocument, createSettingsFs } = await storeApi();
    const corruptBytes = "{corrupt-needs-backup";
    writeFileSync(settingsPath, corruptBytes, "utf-8");

    const failRenameFs = createSettingsFs({
      rename() {
        throw new Error("injected rename failure");
      },
    });
    const backups = () => readdirSync(homeDir).filter((f) => f.includes(".corrupt-"));

    for (let attempt = 0; attempt < 3; attempt++) {
      const replaced = replaceSettingsDocument(
        { ...DEFAULT_USER_SETTINGS },
        { fs: failRenameFs, backupCorrupt: true },
      );
      expect(replaced.ok).toBe(false);
      if (!replaced.ok) expect(replaced.error).toContain("injected rename failure");
      expect(backups()).toEqual([]);
      expect(readFileSync(settingsPath, "utf-8")).toBe(corruptBytes);

      const updated = updateSettingsDocument(
        { ...DEFAULT_USER_SETTINGS },
        {
          fs: failRenameFs,
          baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS },
          onCorrupt: "backup-and-reset-legacy",
        },
      );
      expect(updated.ok).toBe(false);
      if (!updated.ok) expect(updated.error).toContain("injected rename failure");
      expect(backups()).toEqual([]);
      expect(readFileSync(settingsPath, "utf-8")).toBe(corruptBytes);
      expect(readdirSync(homeDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    }

    // The corrupt bytes are still recoverable by a later successful reset.
    const reset = resetUserSettings();
    expect(reset.ok).toBe(true);
    expect(backups()).toHaveLength(1);
    expect(readFileSync(join(homeDir, backups()[0] ?? ""), "utf-8")).toBe(corruptBytes);
  });

  test("bounded key scan handles deep nesting, throwing getters, and toJSON on caller input", async () => {
    const { updateSettingsDocument, replaceSettingsDocument, createSettingsFs } = await storeApi();
    const baseFs = createSettingsFs();

    const baseline = JSON.stringify({ thinking: true }, null, 2) + "\n";
    writeFileSync(settingsPath, baseline, "utf-8");

    let openExclusiveCalls = 0;
    const noWriteSpyFs = createSettingsFs({
      openExclusive(p, mode) {
        openExclusiveCalls++;
        return baseFs.openExclusive(p, mode);
      },
    });

    // 1. 10,000-deep and 40-deep nested patches return { ok: false } without throwing and write nothing
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10_000; i++) {
      deep = { nested: deep };
    }
    const deepUpdateRes = updateSettingsDocument({ deep }, { fs: noWriteSpyFs });
    expect(deepUpdateRes.ok).toBe(false);
    if (!deepUpdateRes.ok) {
      expect(deepUpdateRes.error).toMatch(/depth/i);
    }
    const deepReplaceRes = replaceSettingsDocument({ deep }, { fs: noWriteSpyFs });
    expect(deepReplaceRes.ok).toBe(false);

    let depth40: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 40; i++) {
      depth40 = { nested: depth40 };
    }
    const depth40Res = updateSettingsDocument({ depth40 }, { fs: noWriteSpyFs });
    expect(depth40Res.ok).toBe(false);
    expect(openExclusiveCalls).toBe(0);
    expect(readFileSync(settingsPath, "utf-8")).toBe(baseline);

    // 2. Object with a throwing getter returns { ok: false } without throwing and writes nothing
    const getterHost: Record<string, unknown> = {};
    Object.defineProperty(getterHost, "evil", {
      enumerable: true,
      get() {
        throw new Error("getter-boom");
      },
    });
    const getterUpdateRes = updateSettingsDocument(getterHost, { fs: noWriteSpyFs });
    expect(getterUpdateRes.ok).toBe(false);
    const nestedGetterRes = updateSettingsDocument({ nested: getterHost }, { fs: noWriteSpyFs });
    expect(nestedGetterRes.ok).toBe(false);
    const getterReplaceRes = replaceSettingsDocument(getterHost, { fs: noWriteSpyFs });
    expect(getterReplaceRes.ok).toBe(false);
    expect(openExclusiveCalls).toBe(0);
    expect(readFileSync(settingsPath, "utf-8")).toBe(baseline);

    // 3. Object with toJSON returning forbidden key or throwing returns { ok: false } and writes nothing
    const toJsonForbidden = {
      nested: {
        toJSON() {
          return JSON.parse('{"__proto__": {"polluted": "yes"}}');
        },
      },
    };
    expect(updateSettingsDocument(toJsonForbidden, { fs: noWriteSpyFs }).ok).toBe(false);
    expect(replaceSettingsDocument(toJsonForbidden, { fs: noWriteSpyFs }).ok).toBe(false);
    expect(openExclusiveCalls).toBe(0);
    expect(readFileSync(settingsPath, "utf-8")).toBe(baseline);

  });

  test("keys that only exist on disk (nested constructor, 40-deep unknown) neither block updates/resets nor change", async () => {
    const { updateSettingsDocument, readSettingsDocument } = await storeApi();

    let deep: Record<string, unknown> = { leaf: "deep-value" };
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    const diskDoc = {
      thinking: true,
      custom_constructor: { constructor: { polluted: "no" } },
      custom_deep: deep,
    };
    writeFileSync(settingsPath, JSON.stringify(diskDoc, null, 2) + "\n", "utf-8");

    // An unrelated field can still be updated; the disk-origin keys survive unchanged.
    const updated = updateSettingsDocument({ debug: true });
    expect(updated.ok).toBe(true);
    const afterUpdate = readSettingsDocument();
    expect(afterUpdate.state).toBe("ok");
    expect(afterUpdate.doc.debug).toBe(true);
    expect(afterUpdate.doc.custom_constructor).toEqual(diskDoc.custom_constructor);
    expect(afterUpdate.doc.custom_deep).toEqual(deep);
    expect(Object.getPrototypeOf(afterUpdate.doc)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // Reset also succeeds and leaves the disk-origin keys in place.
    const reset = resetUserSettings();
    expect(reset.ok).toBe(true);
    const afterReset = readSettingsDocument();
    expect(afterReset.doc.thinking).toBe(true);
    expect(afterReset.doc.custom_constructor).toEqual(diskDoc.custom_constructor);
    expect(afterReset.doc.custom_deep).toEqual(deep);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // Caller-supplied input is still scanned: a forbidden key in the patch is rejected.
    const hostilePatch = JSON.parse('{"constructor": {"polluted": "yes"}}') as Record<string, unknown>;
    const rejected = updateSettingsDocument(hostilePatch);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("constructor");
    expect(readSettingsDocument().doc.custom_constructor).toEqual(diskDoc.custom_constructor);
  });

  test("top-level own __proto__ key on disk can be read, updated, and reset without polluting Object.prototype", async () => {
    const { updateSettingsDocument, readSettingsDocument } = await storeApi();

    writeFileSync(settingsPath, '{"__proto__": {"polluted": true}, "thinking": true}\n', "utf-8");

    const initialRead = readSettingsDocument();
    expect(initialRead.state).toBe("ok");
    expect(Object.hasOwn(initialRead.doc, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(initialRead.doc, "__proto__")?.value).toEqual({
      polluted: true,
    });
    expect(Object.getPrototypeOf(initialRead.doc)).toBe(Object.prototype);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();

    // Update another key: __proto__ survives as an own data property and does not pollute prototypes.
    const updated = updateSettingsDocument({ debug: true });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(Object.hasOwn(updated.doc, "__proto__")).toBe(true);
      const desc = Object.getOwnPropertyDescriptor(updated.doc, "__proto__");
      expect(desc?.enumerable).toBe(true);
      expect(desc?.value).toEqual({ polluted: true });
      expect(Object.getPrototypeOf(updated.doc)).toBe(Object.prototype);
    }
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const afterUpdate = readSettingsDocument();
    expect(afterUpdate.state).toBe("ok");
    expect(afterUpdate.doc.debug).toBe(true);
    expect(afterUpdate.doc.thinking).toBe(true);
    expect(Object.hasOwn(afterUpdate.doc, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(afterUpdate.doc, "__proto__")?.value).toEqual({
      polluted: true,
    });

    // Reset also succeeds and preserves the own __proto__ key on disk.
    const reset = resetUserSettings();
    expect(reset.ok).toBe(true);
    const afterReset = readSettingsDocument();
    expect(afterReset.state).toBe("ok");
    expect(afterReset.doc.thinking).toBe(true);
    expect(afterReset.doc.debug).toBe(false);
    expect(Object.hasOwn(afterReset.doc, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(afterReset.doc, "__proto__")?.value).toEqual({
      polluted: true,
    });
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("logs a warning with context when lock.release fails without replacing the committed result", async () => {
    const { updateSettingsDocument } = await storeApi();
    const lockMod = await import("../src/credential-lock.js");
    const realAcquireSync = lockMod.acquireSync;
    const lockPath = join(homeDir, ".settings.json.lock.db");

    const lines: string[] = [];
    const previousLogger = getAppLogger();
    setAppLogger(createTestLogger((line) => lines.push(line)));
    const spy = spyOn(lockMod, "acquireSync").mockImplementation((p: string, opts: { waitMs: number }) => {
      const lock = realAcquireSync(p, opts);
      return {
        release() {
          lock.release();
          throw new Error("injected release failure");
        },
      };
    });

    try {
      const updated = updateSettingsDocument({ thinking: false });
      expect(updated.ok).toBe(true);
      if (updated.ok) expect(updated.doc.thinking).toBe(false);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(lockPath);
      expect(lines[0]).toContain("injected release failure");
    } finally {
      spy.mockRestore();
      setAppLogger(previousLogger);
    }
  });

  test("logs a warning with context when directory fsync fails after a committed rename", async () => {
    const { replaceSettingsDocument, createSettingsFs } = await storeApi();
    const lines: string[] = [];
    const previousLogger = getAppLogger();
    setAppLogger(createTestLogger((line) => lines.push(line)));

    try {
      const fsyncFailFs = createSettingsFs({
        fsyncDir() {
          throw new Error("injected fsyncDir failure");
        },
      });
      const replaced = replaceSettingsDocument({ ...DEFAULT_USER_SETTINGS }, { fs: fsyncFailFs });
      expect(replaced.ok).toBe(true);
      if (replaced.ok) expect(replaced.doc).toEqual(DEFAULT_USER_SETTINGS);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(homeDir);
      expect(lines[0]).toContain("injected fsyncDir failure");
    } finally {
      setAppLogger(previousLogger);
    }
  });

  test("logs a warning with context when discarding a corrupt backup fails", async () => {
    const { updateSettingsDocument, createSettingsFs } = await storeApi();
    const baseFs = createSettingsFs();
    const lines: string[] = [];
    const previousLogger = getAppLogger();
    setAppLogger(createTestLogger((line) => lines.push(line)));

    try {
      writeFileSync(settingsPath, "{corrupt-unlink-fail", "utf-8");
      const unlinkFailFs = createSettingsFs({
        rename() {
          throw new Error("injected rename failure");
        },
        unlink(p) {
          if (p.includes(".corrupt-")) {
            throw new Error("injected unlink failure");
          }
          return baseFs.unlink(p);
        },
      });
      const failedUpdate = updateSettingsDocument(
        { ...DEFAULT_USER_SETTINGS },
        {
          fs: unlinkFailFs,
          baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS },
          onCorrupt: "backup-and-reset-legacy",
        },
      );
      expect(failedUpdate.ok).toBe(false);
      if (!failedUpdate.ok) expect(failedUpdate.error).toContain("injected rename failure");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${settingsPath}.corrupt-`);
      expect(lines[0]).toContain("injected unlink failure");
    } finally {
      setAppLogger(previousLogger);
    }
  });

  test("a throwing logger warn on lock.release failure does not replace the committed result", async () => {
    const { updateSettingsDocument } = await storeApi();
    const lockMod = await import("../src/credential-lock.js");
    const realAcquireSync = lockMod.acquireSync;
    const warnSpy = spyOn(PraanaLogger.prototype, "warn").mockImplementation(() => {
      throw new Error("injected logger warn failure");
    });
    const lockSpy = spyOn(lockMod, "acquireSync").mockImplementation((p: string, opts: { waitMs: number }) => {
      const lock = realAcquireSync(p, opts);
      return {
        release() {
          lock.release();
          throw new Error("injected release failure");
        },
      };
    });

    try {
      const updated = updateSettingsDocument({ thinking: false });
      expect(updated.ok).toBe(true);
      if (updated.ok) expect(updated.doc.thinking).toBe(false);
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ thinking: false });
    } finally {
      lockSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test("a throwing logger warn on directory fsync failure does not replace the committed rename", async () => {
    const { replaceSettingsDocument, createSettingsFs } = await storeApi();
    const warnSpy = spyOn(PraanaLogger.prototype, "warn").mockImplementation(() => {
      throw new Error("injected logger warn failure");
    });

    try {
      const fsyncFailFs = createSettingsFs({
        fsyncDir() {
          throw new Error("injected fsyncDir failure");
        },
      });
      const replaced = replaceSettingsDocument({ ...DEFAULT_USER_SETTINGS }, { fs: fsyncFailFs });
      expect(replaced.ok).toBe(true);
      if (replaced.ok) expect(replaced.doc).toEqual(DEFAULT_USER_SETTINGS);
      expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual(DEFAULT_USER_SETTINGS);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("a throwing logger warn on failed corrupt backup unlink does not mask the write error", async () => {
    const { updateSettingsDocument, createSettingsFs } = await storeApi();
    const baseFs = createSettingsFs();
    const warnSpy = spyOn(PraanaLogger.prototype, "warn").mockImplementation(() => {
      throw new Error("injected logger warn failure");
    });

    try {
      writeFileSync(settingsPath, "{corrupt-logger-warn-fail", "utf-8");
      const unlinkFailFs = createSettingsFs({
        rename() {
          throw new Error("injected rename failure");
        },
        unlink(p) {
          if (p.includes(".corrupt-")) {
            throw new Error("injected unlink failure");
          }
          return baseFs.unlink(p);
        },
      });
      const failedUpdate = updateSettingsDocument(
        { ...DEFAULT_USER_SETTINGS },
        {
          fs: unlinkFailFs,
          baseDefaultsIfMissing: { ...DEFAULT_USER_SETTINGS },
          onCorrupt: "backup-and-reset-legacy",
        },
      );
      expect(failedUpdate.ok).toBe(false);
      if (!failedUpdate.ok) expect(failedUpdate.error).toContain("injected rename failure");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("symlinked settings.json follows symlink on read, replaces target atomically on write, keeps backups and lock next to settings path, and rejects invalid symlink targets with one actionable message", async () => {
    if (process.platform === "win32") return;
    const { readSettingsDocument, updateSettingsDocument, createSettingsFs } = await storeApi();
    const countOccurrences = (haystack: string, needle: string): number =>
      haystack.split(needle).length - 1;

    const dotfilesDir = join(root, "dotfiles");
    mkdirSync(dotfilesDir, { recursive: true });
    const targetPath = join(dotfilesDir, "settings.json");

    // 1. Symlink -> regular file loads without warning, preserves unknown keys, and updates target while keeping symlink intact.
    writeFileSync(targetPath, JSON.stringify({ thinking: false, custom_keep: "yes" }, null, 2) + "\n", "utf-8");
    symlinkSync(targetPath, settingsPath);

    const loaded = loadUserSettings();
    expect(loaded.warning).toBeUndefined();
    expect(loaded.createdDefaults).toBeUndefined();
    expect(loaded.settings.thinking).toBe(false);

    const updated = updateUserSettings({ debug: true });
    expect(updated.ok).toBe(true);
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    const updatedTarget = JSON.parse(readFileSync(targetPath, "utf-8"));
    expect(updatedTarget.debug).toBe(true);
    expect(updatedTarget.thinking).toBe(false);
    expect(updatedTarget.custom_keep).toBe("yes");

    // Lock file stays next to settingsPath (in homeDir), NOT in dotfilesDir; no temp files left behind.
    expect(existsSync(join(homeDir, ".settings.json.lock.db"))).toBe(true);
    expect(existsSync(join(dotfilesDir, ".settings.json.lock.db"))).toBe(false);
    expect(readdirSync(dotfilesDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(homeDir).filter((f) => f.includes(".tmp-"))).toEqual([]);

    // Verify temp file is created in target's directory and readBounded is called on resolved target path.
    const baseFs = createSettingsFs();
    const openedPaths: string[] = [];
    const readPaths: string[] = [];
    const spyFs = createSettingsFs({
      openExclusive(p, mode) {
        openedPaths.push(p);
        return baseFs.openExclusive(p, mode);
      },
      readBounded(p, maxBytes) {
        readPaths.push(p);
        return baseFs.readBounded(p, maxBytes);
      },
    });
    expect(updateSettingsDocument({ incognito: true }, { fs: spyFs }).ok).toBe(true);
    expect(readPaths).toEqual([targetPath]);
    expect(openedPaths.length).toBe(1);
    expect(dirname(openedPaths[0]!)).toBe(dotfilesDir);

    // 2. Reset of a corrupt target backs up corrupt bytes at <settings dir>/settings.json.corrupt-* (0600) and rewrites target.
    const corruptBytes = "{corrupt-dotfiles-target";
    writeFileSync(targetPath, corruptBytes, "utf-8");
    const reset = resetUserSettings();
    expect(reset.ok).toBe(true);
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(targetPath, "utf-8"))).toEqual(DEFAULT_USER_SETTINGS);
    const homeBackups = readdirSync(homeDir).filter((f) => f.startsWith("settings.json.corrupt-"));
    const dotfileBackups = readdirSync(dotfilesDir).filter((f) => f.includes(".corrupt-"));
    expect(homeBackups).toHaveLength(1);
    expect(dotfileBackups).toEqual([]);
    const backupFile = join(homeDir, homeBackups[0]!);
    expect(readFileSync(backupFile, "utf-8")).toBe(corruptBytes);
    expect(statSync(backupFile).mode & 0o777).toBe(0o600);

    // 3. Read-only target directory fails cleanly with no stray temp file and leaves symlink/target intact.
    if (process.getuid?.() !== 0) {
      const beforeReadOnly = readFileSync(targetPath, "utf-8");
      chmodSync(dotfilesDir, 0o555);
      try {
        const roUpdate = updateUserSettings({ debug: false });
        expect(roUpdate.ok).toBe(false);
        expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
        expect(readdirSync(dotfilesDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
        expect(readdirSync(homeDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
      } finally {
        chmodSync(dotfilesDir, 0o755);
      }
      expect(readFileSync(targetPath, "utf-8")).toBe(beforeReadOnly);
    }

    // 4. Invalid symlink targets (dangling, directory, loop, FIFO) each give ONE actionable message naming settingsPath ONCE.
    rmSync(settingsPath, { force: true });

    // Dangling link
    symlinkSync(join(dotfilesDir, "does-not-exist.json"), settingsPath);
    const danglingRead = readSettingsDocument();
    expect(danglingRead.state).toBe("unreadable");
    expect(countOccurrences(danglingRead.error ?? "", settingsPath)).toBe(1);
    const danglingLoad = loadUserSettings();
    expect(danglingLoad.warning).toBeDefined();
    expect(countOccurrences(danglingLoad.warning ?? "", settingsPath)).toBe(1);
    expect(danglingLoad.warning).toMatch(/missing|dangling|create|remove/i);
    const danglingUpdate = updateSettingsDocument({ debug: true });
    expect(danglingUpdate.ok).toBe(false);
    if (!danglingUpdate.ok) {
      expect(danglingUpdate.state).toBe("unreadable");
      expect(countOccurrences(danglingUpdate.error, settingsPath)).toBe(1);
    }
    rmSync(settingsPath, { force: true });

    // Link to directory
    const dirTarget = join(dotfilesDir, "subdir");
    mkdirSync(dirTarget, { recursive: true });
    symlinkSync(dirTarget, settingsPath);
    const dirRead = readSettingsDocument();
    expect(dirRead.state).toBe("unreadable");
    expect(countOccurrences(dirRead.error ?? "", settingsPath)).toBe(1);
    const dirLoad = loadUserSettings();
    expect(dirLoad.warning).toBeDefined();
    expect(countOccurrences(dirLoad.warning ?? "", settingsPath)).toBe(1);
    expect(dirLoad.warning).toMatch(/directory/i);
    rmSync(settingsPath, { force: true });

    // Symlink loop
    const loopOther = join(dotfilesDir, "loop-b");
    symlinkSync(loopOther, settingsPath);
    symlinkSync(settingsPath, loopOther);
    const loopRead = readSettingsDocument();
    expect(loopRead.state).toBe("unreadable");
    expect(countOccurrences(loopRead.error ?? "", settingsPath)).toBe(1);
    const loopLoad = loadUserSettings();
    expect(loopLoad.warning).toBeDefined();
    expect(countOccurrences(loopLoad.warning ?? "", settingsPath)).toBe(1);
    expect(loopLoad.warning).toMatch(/loop/i);
    rmSync(settingsPath, { force: true });
    rmSync(loopOther, { force: true });

    // Link to FIFO
    const fifoTarget = join(dotfilesDir, "settings.fifo");
    const mkfifo = Bun.spawnSync(["mkfifo", fifoTarget]);
    if (mkfifo.exitCode === 0) {
      symlinkSync(fifoTarget, settingsPath);
      const fifoRead = readSettingsDocument();
      expect(fifoRead.state).toBe("unreadable");
      expect(countOccurrences(fifoRead.error ?? "", settingsPath)).toBe(1);
      const fifoLoad = loadUserSettings();
      expect(fifoLoad.warning).toBeDefined();
      expect(countOccurrences(fifoLoad.warning ?? "", settingsPath)).toBe(1);
      expect(fifoLoad.warning).toMatch(/regular file/i);
      rmSync(settingsPath, { force: true });
    }
  });

  test("default_model.reasoning shares REASONING_EFFORT_LEVELS and parseReasoningEffort with llm.ts without diverging", async () => {
    const { REASONING_LEVELS, parseDefaultModel, updateSettingsDocument, loadSettingsFile } =
      await storeApi();
    const { REASONING_EFFORT_LEVELS, parseReasoningEffort } = await import("../src/llm.js");

    // The two lists cannot diverge: same canonical entries.
    expect([...REASONING_LEVELS]).toEqual([...REASONING_EFFORT_LEVELS]);
    expect(REASONING_LEVELS).toBe(REASONING_EFFORT_LEVELS);

    // Every canonical level and alias ("none", whitespace/case variants) matches llm.ts normalization and round-trips.
    const acceptedInputs = [...REASONING_EFFORT_LEVELS, "none", "NONE", " high "];
    for (const token of acceptedInputs) {
      const expected = parseReasoningEffort(token);
      expect(expected).not.toBeNull();
      const parsed = parseDefaultModel({ provider: "openai", model: "gpt-4o", reasoning: token });
      expect(parsed.errors).toEqual([]);
      expect(parsed.value).toEqual({
        provider: "openai",
        model: "gpt-4o",
        reasoning: expected!,
      });

      const saved = updateSettingsDocument({
        default_model: parsed.value,
      });
      expect(saved.ok).toBe(true);
      const loaded = loadSettingsFile();
      expect(loaded.invalidKeys).toEqual([]);
      expect(loaded.defaultModel).toEqual({
        provider: "openai",
        model: "gpt-4o",
        reasoning: expected!,
      });
    }

    // Unknown or non-string reasoning levels are rejected.
    for (const badToken of ["bogus", "", "   ", 123, null]) {
      const badParsed = parseDefaultModel({ provider: "openai", model: "gpt-4o", reasoning: badToken });
      expect(badParsed.value).toBeNull();
      expect(badParsed.errors.map((e) => e.key)).toContain("default_model.reasoning");
    }
  });
});
