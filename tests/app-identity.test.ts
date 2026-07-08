import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appHomePath,
  markInitialized,
  isFirstRun,
  APP_HOME_DIR,
} from "../src/app-identity.js";

describe("app identity", () => {
  let root: string;
  const originalPraanaHome = process.env.PRAANA_HOME;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "praana-identity-test-"));
    delete process.env.PRAANA_HOME;
  });

  afterEach(() => {
    if (originalPraanaHome !== undefined) {
      process.env.PRAANA_HOME = originalPraanaHome;
    } else {
      delete process.env.PRAANA_HOME;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults appHomePath to ~/.praana", () => {
    const expected = join(require("node:os").homedir(), APP_HOME_DIR);
    expect(appHomePath()).toBe(expected);
  });

  it("treats PRAANA_HOME as the parent of .praana", () => {
    process.env.PRAANA_HOME = root;
    expect(appHomePath()).toBe(join(root, APP_HOME_DIR));
    expect(appHomePath("config.toml")).toBe(join(root, APP_HOME_DIR, "config.toml"));
  });

  it("markInitialized returns false when the home directory is unwritable", () => {
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "", "utf-8");
    process.env.PRAANA_HOME = filePath;

    const result = markInitialized();
    expect(result).toBe(false);
    expect(isFirstRun()).toBe(true);
  });

  it("markInitialized returns true and writes the initialized marker", () => {
    process.env.PRAANA_HOME = root;

    const result = markInitialized();
    expect(result).toBe(true);
    expect(isFirstRun()).toBe(false);
  });
});
