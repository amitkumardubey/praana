import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { NativeUnavailableError } from "../src/native/types.js";
import { formatNativeStatus, nativeStatusToString } from "../src/native/index.js";
import { buildSystemFrame } from "../src/compiler.js";
import { buildClassicSystemFrame } from "../src/compile-classic.js";
import { Session } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { resetNativeLoadCache, setNativeEnabled } from "../src/native/index.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { NativeLoadResult, NativeBindings } from "../src/native/types.js";

function mockAvailableBindings(): NativeBindings {
  return {
    nativeVersion: () => "0.3.1",
    ping: () => "",
    parseFile: () => ({ ok: true, diagnostics: [] }),
    listSymbols: () => ({ ok: true, diagnostics: [], symbols: [] }),
    listImports: () => ({ ok: true, diagnostics: [], imports: [] }),
    findDefinition: () => ({ ok: true, hits: [], truncated: false, filesScanned: 0 }),
    findReferences: () => ({ ok: true, hits: [], truncated: false, filesScanned: 0 }),
  };
}

describe("formatNativeStatus", () => {
  it("formats available with version", () => {
    const s = formatNativeStatus({
      available: true,
      bindings: mockAvailableBindings(),
      error: null,
    });
    expect(s.kind).toBe("available");
    if (s.kind === "available") expect(s.version).toBe("0.3.1");
  });

  it("formats disabled via config (by error code)", () => {
    const s = formatNativeStatus({
      available: false,
      bindings: null,
      error: new NativeUnavailableError("disabled", "native addon disabled via config (native.enabled=false)"),
    });
    expect(s.kind).toBe("disabled");
    if (s.kind === "disabled") expect(s.reason).toContain("disabled");
  });

  it("formats unavailable with causeMessage", () => {
    const s = formatNativeStatus({
      available: false,
      bindings: null,
      error: new NativeUnavailableError("unavailable", "native addon failed to load", "Cannot find module"),
    });
    expect(s.kind).toBe("unavailable");
    if (s.kind === "unavailable") expect(s.reason).toBe("Cannot find module");
  });

  it("formats unavailable with message fallback (no causeMessage)", () => {
    const s = formatNativeStatus({
      available: false,
      bindings: null,
      error: new NativeUnavailableError("unavailable", "some error"),
    });
    expect(s.kind).toBe("unavailable");
    if (s.kind === "unavailable") expect(s.reason).toBe("some error");
  });

  it("handles null error", () => {
    const s = formatNativeStatus({ available: false, bindings: null, error: null });
    expect(s.kind).toBe("unavailable");
    if (s.kind === "unavailable") expect(s.reason).toBe("unknown");
  });
});

describe("nativeStatusToString", () => {
  it("renders available with version", () => {
    expect(nativeStatusToString({ kind: "available", version: "0.3.1" })).toBe("available (0.3.1)");
  });

  it("renders disabled", () => {
    expect(nativeStatusToString({ kind: "disabled", reason: "native addon disabled" })).toBe("disabled via config");
  });

  it("renders unavailable", () => {
    expect(nativeStatusToString({ kind: "unavailable", reason: "Cannot find module" })).toBe("unavailable: Cannot find module");
  });
});

describe("buildSystemFrame native addon", () => {
  it("omits Native Addon section when available", () => {
    const frame = buildSystemFrame("/proj", "sess-1", [], undefined, null, false, undefined, { kind: "available", version: "0.3.1" });
    expect(frame).not.toContain("## Native Addon");
  });

  it("injects Native Addon section when unavailable", () => {
    const frame = buildSystemFrame("/proj", "sess-1", [], undefined, null, false, undefined, { kind: "unavailable", reason: "Cannot find module" });
    expect(frame).toContain("## Native Addon");
    expect(frame).toContain("unavailable: Cannot find module");
    expect(frame).toContain("Prefer search_code");
  });

  it("injects Native Addon section when disabled", () => {
    const frame = buildSystemFrame("/proj", "sess-1", [], undefined, null, false, undefined, { kind: "disabled", reason: "native.enabled=false" });
    expect(frame).toContain("## Native Addon");
    expect(frame).toContain("disabled via config");
  });

  it("omits Native Addon section when null", () => {
    const frame = buildSystemFrame("/proj", "sess-1", [], undefined, null, false, undefined, null);
    expect(frame).not.toContain("## Native Addon");
  });
});

describe("buildClassicSystemFrame native addon", () => {
  it("injects Native Addon section when unavailable", () => {
    const frame = buildClassicSystemFrame("/proj", "sess-1", [], null, null, undefined, { kind: "unavailable", reason: "probe failed" });
    expect(frame).toContain("## Native Addon");
    expect(frame).toContain("unavailable: probe failed");
  });

  it("omits Native Addon section when available", () => {
    const frame = buildClassicSystemFrame("/proj", "sess-1", [], null, null, undefined, { kind: "available", version: "0.3.1" });
    expect(frame).not.toContain("## Native Addon");
  });
});

describe("Session nativeStatus probing", () => {
  let tmpDir: string;

  beforeEach(() => {
    resetNativeLoadCache();
    tmpDir = join(tmpdir(), `praana-native-status-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  });

  afterEach(async () => {
    resetNativeLoadCache();
    setNativeEnabled(true);
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets disabled via config when native.enabled=false", async () => {
    const config = loadConfig();
    config.native = { enabled: false, require: false };
    config.session.log_dir = join(tmpDir, "sessions");
    const session = await Session.create(tmpDir, config);
    expect(session.nativeStatus).not.toBeNull();
    expect(session.nativeStatus!.kind).toBe("disabled");
    await session.end("clean", []);
  });

  it("sets available or unavailable via real probe", async () => {
    const config = loadConfig();
    config.native = { enabled: true, require: false };
    config.session.log_dir = join(tmpDir, "sessions");
    const session = await Session.create(tmpDir, config);
    expect(session.nativeStatus).toBeTruthy();
    const kind = session.nativeStatus!.kind;
    expect(kind === "available" || kind === "unavailable" || kind === "disabled").toBe(true);
    await session.end("clean", []);
  });
});
