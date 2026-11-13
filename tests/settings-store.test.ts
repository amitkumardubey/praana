import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_HOME_DIR } from "../src/app-identity.js";
import { resolveActiveModelAndProvider } from "../src/llm/resolver.js";
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

    // 6. unreadable: symlink (ordinary and dangling)
    if (process.platform !== "win32") {
      const targetFile = join(root, "outside.json");
      writeFileSync(targetFile, '{"thinking":true}', "utf-8");
      symlinkSync(targetFile, settingsPath);
      expect(readSettingsDocument().state).toBe("unreadable");
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

    // If backup copyFile fails, original corrupt file is untouched and reset returns error.
    const failingBackupFs = createSettingsFs({
      copyFile() {
        throw new Error("backup disk full");
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
      const outside = join(root, "outside-target.json");
      writeFileSync(outside, '{"keep":true}', "utf-8");
      symlinkSync(outside, settingsPath);
      expect(updateUserSettings({ thinking: false }).ok).toBe(false);
      expect(saveUserSettings(DEFAULT_USER_SETTINGS).ok).toBe(false);
      expect(resetUserSettings().ok).toBe(false);
      expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(outside, "utf-8")).toBe('{"keep":true}');
      rmSync(settingsPath, { force: true });
    }

    // Refuses to write a document exceeding MAX_SETTINGS_BYTES without touching existing file
    const originalValid = '{"thinking":true}\n';
    writeFileSync(settingsPath, originalValid, "utf-8");
    const hugeWrite = updateSettingsDocument({ huge: "x".repeat(MAX_SETTINGS_BYTES + 100) });
    expect(hugeWrite.ok).toBe(false);
    expect(readFileSync(settingsPath, "utf-8")).toBe(originalValid);
  });

  test("filesystem seam exposes the 11 operations, enforces 0600 permissions, closes descriptors, and preserves original bytes on failure", async () => {
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
});
