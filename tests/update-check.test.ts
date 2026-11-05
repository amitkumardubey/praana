import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APP_HOME_DIR } from "../src/app-identity.js";
import { runUpgrade } from "../src/update/upgrade.js";
import {
  UPDATE_CHECK_TTL_MS,
  formatUpdateNotice,
  getUpdateCheckPath,
  readUpdateCheckCache,
  refreshUpdateCheck,
  refreshUpgradeCheck,
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

  it("forces a fresh registry check despite a fresh cache and updates it", async () => {
    writeUpdateCheckCache({ version: 1, checkedAt: Date.now(), latestVersion: "0.18.0", source: "npm" });
    const result = await refreshUpdateCheck({
      currentVersion: "v0.18.0", env: {}, forceRefresh: true,
      fetchImpl: async () => new Response(JSON.stringify({ version: "0.18.1" })),
    });
    expect(result?.latest).toBe("0.18.1");
    expect(result?.available).toBe(true);
    expect(result?.fromCache).toBe(false);
    expect(readUpdateCheckCache()?.latestVersion).toBe("0.18.1");
  });

  it("uses a fresh cache only as fallback when a forced registry check fails", async () => {
    writeUpdateCheckCache({ version: 1, checkedAt: Date.now(), latestVersion: "0.18.0", source: "npm" });
    let fetched = false;
    const result = await refreshUpdateCheck({
      currentVersion: "v0.18.0", env: {}, forceRefresh: true,
      fetchImpl: async () => { fetched = true; throw new Error("offline"); },
    });
    expect(fetched).toBe(true);
    expect(result?.fromCache).toBe(true);
    expect(result?.latest).toBe("0.18.0");
  });

  it("uses the newer GitHub release when npm lags", async () => {
    const calls: string[] = [];
    const result = await refreshUpgradeCheck({ currentVersion: "0.18.0", env: {}, fetchImpl: async (url, init) => {
      calls.push(String(url));
      expect((init?.headers as Record<string, string>)["User-Agent"]).toBe("praana/0.18.0");
      return new Response(JSON.stringify(String(url).includes("github.com") ? { tag_name: "v0.18.1" } : { version: "0.18.0" }));
    } });
    expect(calls).toHaveLength(2);
    expect(result?.latest).toBe("0.18.1");
    expect(result?.available).toBe(true);
    const upgrade = await runUpgrade({ kind: "standalone", currentVersion: "v0.18.0", latestVersion: result?.latest,
      runInstaller: async () => ({ ok: true, output: "" }), versionOf: () => "PRAANA v0.18.1" });
    expect(upgrade.ranInstaller).toBe(true);
    expect(upgrade.lines.join("\n")).toContain("PRAANA v0.18.1");
  });

  it("uses the higher npm version for the check without claiming it was installed", async () => {
    const result = await refreshUpgradeCheck({ currentVersion: "0.18.0", env: {}, fetchImpl: async (url) =>
      new Response(JSON.stringify(String(url).includes("github.com") ? { tag_name: "v0.18.1" } : { version: "0.18.2" })) });
    expect(result?.latest).toBe("0.18.2");
    const upgrade = await runUpgrade({ kind: "standalone", currentVersion: "0.18.0", latestVersion: result?.latest,
      runInstaller: async () => ({ ok: true, output: "" }), versionOf: () => "PRAANA v0.18.1" });
    expect(upgrade.lines.join("\n")).toContain("PRAANA v0.18.1");
    expect(upgrade.lines.join("\n")).not.toContain("0.18.2");
  });

  it("uses npm when GitHub is rate limited", async () => {
    const result = await refreshUpgradeCheck({ currentVersion: "0.18.0", env: {}, fetchImpl: async (url) =>
      String(url).includes("github.com") ? new Response("", { status: 403 }) : new Response(JSON.stringify({ version: "0.18.1" })) });
    expect(result?.latest).toBe("0.18.1");
  });

  it("ignores prerelease and invalid release tags", async () => {
    for (const tag of ["v0.19.0-rc.1", "v0.19.0oops", "garbage"]) {
      const result = await refreshUpgradeCheck({ currentVersion: "0.18.0", env: {}, fetchImpl: async (url) =>
        new Response(JSON.stringify(String(url).includes("github.com") ? { tag_name: tag } : { version: "0.18.1" })) });
      expect(result?.latest).toBe("0.18.1");
    }
  });

  it("reports both sources unavailable without a cache", async () => {
    const result = await refreshUpgradeCheck({ currentVersion: "0.18.0", env: {}, fetchImpl: async () => { throw new Error("offline"); } });
    expect(result).toBeNull();
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
