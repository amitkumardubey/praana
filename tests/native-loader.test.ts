import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EXPECTED_NATIVE_API_MAJOR,
  loadNative,
  resetNativeLoadCache,
  NativeUnavailableError,
} from "../src/native/index.js";

describe("native loader", () => {
  let fixtureDir: string;

  beforeEach(() => {
    resetNativeLoadCache();
    fixtureDir = join(
      tmpdir(),
      `praana-native-loader-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(fixtureDir, { recursive: true });
  });

  afterEach(() => {
    resetNativeLoadCache();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it("reports unavailable when import fails", async () => {
    const result = await loadNative({
      forceReload: true,
      importSpecifier: join(fixtureDir, "does-not-exist.mjs"),
    });
    expect(result.available).toBe(false);
    expect(result.bindings).toBeNull();
    expect(result.error).toBeInstanceOf(NativeUnavailableError);
    expect(result.error?.code).toBe("unavailable");
  });

  it("rejects modules missing required exports", async () => {
    const path = join(fixtureDir, "empty-native.mjs");
    writeFileSync(path, "export const foo = 1;\n");
    const result = await loadNative({
      forceReload: true,
      importSpecifier: path,
    });
    expect(result.available).toBe(false);
    expect(result.error?.code).toBe("unavailable");
    expect(result.error?.message).toContain("required exports");
  });

  it("rejects incompatible major versions", async () => {
    const path = join(fixtureDir, "bad-major.mjs");
    writeFileSync(
      path,
      `export function nativeVersion() { return "99.0.0"; }\nexport function ping() { return "pong"; }\n`,
    );
    const result = await loadNative({
      forceReload: true,
      importSpecifier: path,
    });
    expect(result.available).toBe(false);
    expect(result.error?.code).toBe("version_mismatch");
    expect(result.error?.message).toContain("99");
    expect(result.error?.message).toContain(String(EXPECTED_NATIVE_API_MAJOR));
  });

  it("loads a compatible stub module", async () => {
    const path = join(fixtureDir, "good-native.mjs");
    writeFileSync(
      path,
      `export function nativeVersion() { return "${EXPECTED_NATIVE_API_MAJOR}.1.0"; }\nexport function ping() { return "pong"; }\n`,
    );
    const result = await loadNative({
      forceReload: true,
      importSpecifier: path,
    });
    expect(result.available).toBe(true);
    expect(result.error).toBeNull();
    expect(result.bindings?.ping()).toBe("pong");
    expect(result.bindings?.nativeVersion()).toBe(`${EXPECTED_NATIVE_API_MAJOR}.1.0`);
  });

  it("caches the first load result", async () => {
    const path = join(fixtureDir, "cache-native.mjs");
    writeFileSync(
      path,
      `export function nativeVersion() { return "0.1.0"; }\nexport function ping() { return "pong"; }\n`,
    );
    const first = await loadNative({ forceReload: true, importSpecifier: path });
    expect(first.available).toBe(true);
    const second = await loadNative({ importSpecifier: join(fixtureDir, "other.mjs") });
    expect(second).toBe(first);
  });
});

describe("native addon integration (optional)", () => {
  it("loads @praana/natives when the addon is built", async () => {
    resetNativeLoadCache();
    const result = await loadNative({ forceReload: true });
    if (!result.available) {
      // Skeleton PRs may run without a local cargo build; loader contract still holds.
      expect(result.error).toBeInstanceOf(NativeUnavailableError);
      return;
    }
    expect(result.bindings!.ping()).toBe("pong");
    expect(result.bindings!.nativeVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
