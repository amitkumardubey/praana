import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { formatNativeStatus } from "../src/session.js";
import { buildSystemFrame } from "../src/compiler.js";
import { buildClassicSystemFrame } from "../src/compile-classic.js";
import { Session } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { resetNativeLoadCache, setNativeEnabled } from "../src/native/index.js";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("formatNativeStatus", () => {
  it("formats available with version", () => {
    const s = formatNativeStatus({
      available: true,
      bindings: { nativeVersion: () => "0.3.1" },
      error: null,
    });
    expect(s).toBe("available (0.3.1)");
  });

  it("formats disabled via config", () => {
    const s = formatNativeStatus({
      available: false,
      bindings: null,
      error: { message: "native addon disabled via config (native.enabled=false)" },
    });
    expect(s).toBe("disabled via config");
  });

  it("formats unavailable with causeMessage", () => {
    const s = formatNativeStatus({
      available: false,
      bindings: null,
      error: { message: "native addon failed to load", causeMessage: "Cannot find module" },
    });
    expect(s).toBe("unavailable: Cannot find module");
  });

  it("formats unavailable with message fallback", () => {
    const s = formatNativeStatus({
      available: false,
      bindings: null,
      error: { message: "some error" },
    });
    expect(s).toBe("unavailable: some error");
  });

  it("handles null error", () => {
    const s = formatNativeStatus({ available: false, bindings: null, error: null });
    expect(s).toBe("unavailable: unknown");
  });
});

describe("buildSystemFrame native addon", () => {
  it("omits Native Addon section when available", () => {
    const frame = buildSystemFrame("/proj", "sess-1", [], undefined, null, false, undefined, "available (0.3.1)");
    expect(frame).not.toContain("## Native Addon");
  });

  it("injects Native Addon section when unavailable", () => {
    const frame = buildSystemFrame("/proj", "sess-1", [], undefined, null, false, undefined, "unavailable: Cannot find module");
    expect(frame).toContain("## Native Addon");
    expect(frame).toContain("unavailable: Cannot find module");
    expect(frame).toContain("Prefer search_code");
  });

  it("injects Native Addon section when disabled", () => {
    const frame = buildSystemFrame("/proj", "sess-1", [], undefined, null, false, undefined, "disabled via config");
    expect(frame).toContain("## Native Addon");
  });

  it("omits Native Addon section when null", () => {
    const frame = buildSystemFrame("/proj", "sess-1", [], undefined, null, false, undefined, null);
    expect(frame).not.toContain("## Native Addon");
  });
});

describe("buildClassicSystemFrame native addon", () => {
  it("injects Native Addon section when unavailable", () => {
    const frame = buildClassicSystemFrame("/proj", "sess-1", [], null, null, undefined, "unavailable: probe failed");
    expect(frame).toContain("## Native Addon");
  });

  it("omits Native Addon section when available", () => {
    const frame = buildClassicSystemFrame("/proj", "sess-1", [], null, null, undefined, "available (0.3.1)");
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
    // use a temp log dir to avoid polluting real sessions
    config.session.log_dir = join(tmpDir, "sessions");
    const session = await Session.create(tmpDir, config);
    expect(session.nativeStatus).toBe("disabled via config");
    await session.end("clean", []);
  });

  it("sets available or unavailable string via real probe", async () => {
    const config = loadConfig();
    config.native = { enabled: true, require: false };
    config.session.log_dir = join(tmpDir, "sessions");
    const session = await Session.create(tmpDir, config);
    expect(session.nativeStatus).toBeTruthy();
    expect(typeof session.nativeStatus).toBe("string");
    // Should be either available (...) or unavailable: ...
    expect(
      session.nativeStatus!.startsWith("available") ||
        session.nativeStatus!.startsWith("unavailable") ||
        session.nativeStatus === "disabled via config",
    ).toBe(true);
    await session.end("clean", []);
  });
});
