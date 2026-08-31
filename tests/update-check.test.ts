import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APP_HOME_DIR } from "../src/app-identity.js";
import {
  UPDATE_CHECK_TTL_MS,
  formatUpdateNotice,
  getUpdateCheckPath,
  readUpdateCheckCache,
  refreshUpdateCheck,
  shouldSkipUpdateCheck,
  writeUpdateCheckCache,
} from "../src/update/check.js";

describe("shouldSkipUpdateCheck", () => {
  it("skips CI, tests, headless, and PRAANA_NO_UPDATE_CHECK", () => {
    expect(shouldSkipUpdateCheck({ CI: "true" }, { isTty: true, runMode: false })).toBe(true);
    expect(shouldSkipUpdateCheck({ VITEST: "true" }, { isTty: true, runMode: false })).toBe(true);
    expect(shouldSkipUpdateCheck({ NODE_ENV: "test" }, { isTty: true, runMode: false })).toBe(true);
    expect(
      shouldSkipUpdateCheck({ PRAANA_NO_UPDATE_CHECK: "1" }, { isTty: true, runMode: false }),
    ).toBe(true);
    expect(shouldSkipUpdateCheck({}, { isTty: true, runMode: true })).toBe(true);
    expect(shouldSkipUpdateCheck({}, { isTty: false, runMode: false })).toBe(true);
  });

  it("allows an interactive TTY session", () => {
    expect(shouldSkipUpdateCheck({}, { isTty: true, runMode: false })).toBe(false);
  });
});

describe("formatUpdateNotice", () => {
  it("prints current → latest and the upgrade command", () => {
    expect(formatUpdateNotice("v0.15.1", "0.16.0")).toBe(
      "Update available: v0.15.1 → v0.16.0 · praana upgrade",
    );
  });
});

describe("refreshUpdateCheck", () => {
  const originalHome = process.env.PRAANA_HOME;
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `praana-update-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, APP_HOME_DIR), { recursive: true });
    process.env.PRAANA_HOME = root;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.PRAANA_HOME = originalHome;
    else delete process.env.PRAANA_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  it("returns cached latest without fetching when TTL is fresh", async () => {
    writeUpdateCheckCache({
      version: 1,
      checkedAt: Date.now(),
      latestVersion: "0.16.0",
      source: "npm",
    });
    let fetched = 0;
    const result = await refreshUpdateCheck({
      currentVersion: "v0.15.1",
      env: {},
      isTty: true,
      runMode: false,
      fetchImpl: async () => {
        fetched += 1;
        return new Response("{}", { status: 200 });
      },
    });
    expect(fetched).toBe(0);
    expect(result?.available).toBe(true);
    expect(result?.latest).toBe("0.16.0");
    expect(result?.fromCache).toBe(true);
  });

  it("fetches npm latest when the cache is stale", async () => {
    writeUpdateCheckCache({
      version: 1,
      checkedAt: Date.now() - UPDATE_CHECK_TTL_MS - 1,
      latestVersion: "0.14.0",
      source: "npm",
    });
    const result = await refreshUpdateCheck({
      currentVersion: "v0.15.1",
      env: {},
      isTty: true,
      runMode: false,
      fetchImpl: async () =>
        new Response(JSON.stringify({ version: "0.16.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    expect(result?.available).toBe(true);
    expect(result?.latest).toBe("0.16.0");
    expect(result?.fromCache).toBe(false);
    const disk = JSON.parse(readFileSync(getUpdateCheckPath(), "utf-8"));
    expect(disk.latestVersion).toBe("0.16.0");
  });

  it("fails silent on fetch errors", async () => {
    const result = await refreshUpdateCheck({
      currentVersion: "v0.15.1",
      env: {},
      isTty: true,
      runMode: false,
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(result).toBeNull();
    expect(existsSync(getUpdateCheckPath())).toBe(false);
  });

  it("skips without fetching when env says so", async () => {
    let fetched = 0;
    const result = await refreshUpdateCheck({
      currentVersion: "v0.15.1",
      env: { CI: "true" },
      isTty: true,
      runMode: false,
      fetchImpl: async () => {
        fetched += 1;
        return new Response("{}", { status: 200 });
      },
    });
    expect(fetched).toBe(0);
    expect(result).toBeNull();
  });

  it("readUpdateCheckCache returns null for missing files", () => {
    expect(readUpdateCheckCache()).toBeNull();
  });
});
