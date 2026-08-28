import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EXPECTED_NATIVE_API_MAJOR,
  SIDECAR_ADDON_FILENAME,
  loadNative,
  resetNativeLoadCache,
  resolveSidecarAddonPath,
  setNativeEnabled,
  NativeUnavailableError,
  isNativeAddonPath,
} from "../src/native/index.js";

function stubNativeModule(version: string): string {
  return `
export function nativeVersion() { return ${JSON.stringify(version)}; }
export function ping() { return "pong"; }
export function parseFile() {
  return { ok: true, language: "typescript", diagnostics: [] };
}
export function listSymbols() {
  return { ok: true, language: "typescript", symbols: [] };
}
export function listImports() {
  return { ok: true, language: "typescript", imports: [] };
}
export function findDefinition() {
  return { ok: true, hits: [], truncated: false, filesScanned: 0 };
}
export function findReferences() {
  return { ok: true, hits: [], truncated: false, filesScanned: 0 };
}
export function grep() {
  return { ok: true, matches: [], truncated: false, filesSearched: 0 };
}
export function findFiles() {
  return { ok: true, matches: [], truncated: false, totalMatched: 0 };
}
export function embedText() {
  return { ok: false, dim: 0, embedding: [], code: "unavailable", error: "no model" };
}
`;
}

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
    expect(result.error?.message).toContain("required export");
  });

  it("rejects incompatible major versions", async () => {
    const path = join(fixtureDir, "bad-major.mjs");
    writeFileSync(path, stubNativeModule("99.0.0"));
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
    writeFileSync(path, stubNativeModule(`${EXPECTED_NATIVE_API_MAJOR}.2.0`));
    const result = await loadNative({
      forceReload: true,
      importSpecifier: path,
    });
    expect(result.available).toBe(true);
    expect(result.error).toBeNull();
    expect(result.bindings?.ping()).toBe("pong");
    expect(result.bindings?.nativeVersion()).toBe(`${EXPECTED_NATIVE_API_MAJOR}.2.0`);
    expect(result.bindings?.listSymbols("/x.ts").ok).toBe(true);
  });

  it("caches the first load result", async () => {
    const path = join(fixtureDir, "cache-native.mjs");
    writeFileSync(path, stubNativeModule("0.2.0"));
    const first = await loadNative({ forceReload: true, importSpecifier: path });
    expect(first.available).toBe(true);
    const second = await loadNative({ importSpecifier: join(fixtureDir, "other.mjs") });
    expect(second).toBe(first);
  });

  it("loads a compatible stub from the sidecar when the package import fails", async () => {
    const missing = join(fixtureDir, "does-not-exist.mjs");
    const sidecar = join(fixtureDir, "praana-natives.node.mjs");
    writeFileSync(sidecar, stubNativeModule(`${EXPECTED_NATIVE_API_MAJOR}.2.0`));
    const result = await loadNative({
      forceReload: true,
      importSpecifier: missing,
      sidecarPath: sidecar,
    });
    expect(result.available).toBe(true);
    expect(result.bindings?.ping()).toBe("pong");
  });

  it("resolves the sidecar next to process.execPath", () => {
    expect(resolveSidecarAddonPath("/opt/praana/praana")).toBe(
      join("/opt/praana", SIDECAR_ADDON_FILENAME),
    );
  });

  it("identifies .node paths for require-based loading", () => {
    expect(isNativeAddonPath("/opt/praana/praana-natives.node")).toBe(true);
    expect(isNativeAddonPath("@praana/natives")).toBe(false);
    expect(isNativeAddonPath(join(fixtureDir, "stub.mjs"))).toBe(false);
  });

  it("loads a real .node sidecar via require when present", async () => {
    const nativesDir = join(import.meta.dir, "../packages/praana-natives");
    const built = existsSync(nativesDir)
      ? readdirSync(nativesDir)
          .filter((name) => name.endsWith(".node"))
          .map((name) => join(nativesDir, name))[0]
      : undefined;
    if (!built) return;

    const result = await loadNative({
      forceReload: true,
      importSpecifier: join(fixtureDir, "does-not-exist.mjs"),
      sidecarPath: built,
      execPath: join(fixtureDir, "praana"),
    });
    expect(result.available).toBe(true);
    expect(result.bindings?.ping()).toBe("pong");
    expect(typeof result.bindings?.grep).toBe("function");
  });

  it("respects native.enabled=false via setNativeEnabled", async () => {
    setNativeEnabled(false);
    const result = await loadNative({ forceReload: true });
    expect(result.available).toBe(false);
    expect(result.error?.code).toBe("disabled");
    expect(result.error?.message).toContain("disabled");
  });
});

describe("native addon integration (optional)", () => {
  it("loads @praana/natives when the addon is built", async () => {
    resetNativeLoadCache();
    const result = await loadNative({ forceReload: true });
    if (!result.available) {
      expect(result.error).toBeInstanceOf(NativeUnavailableError);
      return;
    }
    expect(result.bindings!.ping()).toBe("pong");
    expect(result.bindings!.nativeVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof result.bindings!.listSymbols).toBe("function");
    expect(typeof result.bindings!.parseFile).toBe("function");
  });
});
