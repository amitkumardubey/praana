/**
 * Tests for the pi-tui crash/debug log redirect.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPiTuiLogRedirect,
  uninstallPiTuiLogRedirect,
  getPiTuiLogRedirectTarget,
  isPiTuiLogRedirectInstalled,
} from "../src/ui/tui/redirect-pi-logs.js";

// pi-tui patches the CommonJS `node:fs` exports object. Use require() in the
// tests so we exercise the same function references that pi-tui sees.
const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");

// Ensure a clean slate and restore after each test so other suites are not
// affected by the global fs patch.
describe("redirect-pi-logs", () => {
  beforeEach(() => {
    uninstallPiTuiLogRedirect();
  });

  afterEach(() => {
    uninstallPiTuiLogRedirect();
  });

  describe("getPiTuiLogRedirectTarget", () => {
    it("redirects pi-tui crash log to ~/.praana/logs/pi-crash.log", () => {
      const target = getPiTuiLogRedirectTarget("/home/user/.pi/agent/pi-crash.log");
      expect(target).toEndWith("/.praana/logs/pi-crash.log");
    });

    it("redirects pi-tui debug log to ~/.praana/logs/pi-debug.log", () => {
      const target = getPiTuiLogRedirectTarget("/home/user/.pi/agent/pi-debug.log");
      expect(target).toEndWith("/.praana/logs/pi-debug.log");
    });

    it("does not redirect unrelated paths", () => {
      expect(getPiTuiLogRedirectTarget("/home/user/.pi/agent/other.log")).toBeUndefined();
      expect(getPiTuiLogRedirectTarget("/home/user/.pi/pi-crash.log")).toBeUndefined();
      expect(getPiTuiLogRedirectTarget("/tmp/pi-crash.log")).toBeUndefined();
    });
  });

  describe("fs patch", () => {
    let tmpHome: string;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(join(tmpdir(), "praana-redirect-test-"));
      process.env.PRAANA_HOME = tmpHome;
    });

    afterEach(() => {
      delete process.env.PRAANA_HOME;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("redirects fs.writeFileSync for the crash log", () => {
      installPiTuiLogRedirect();
      const piPath = join(tmpHome, ".pi", "agent", "pi-crash.log");
      fs.writeFileSync(piPath, "crash data");
      const praanaPath = join(tmpHome, ".praana", "logs", "pi-crash.log");
      expect(fs.existsSync(praanaPath)).toBe(true);
      expect(fs.readFileSync(praanaPath, "utf8")).toBe("crash data");
      expect(fs.existsSync(piPath)).toBe(false);
    });

    it("redirects fs.appendFileSync for the debug log", () => {
      installPiTuiLogRedirect();
      const piPath = join(tmpHome, ".pi", "agent", "pi-debug.log");
      fs.appendFileSync(piPath, "line 1\n");
      fs.appendFileSync(piPath, "line 2\n");
      const praanaPath = join(tmpHome, ".praana", "logs", "pi-debug.log");
      expect(fs.existsSync(praanaPath)).toBe(true);
      expect(fs.readFileSync(praanaPath, "utf8")).toBe("line 1\nline 2\n");
      expect(fs.existsSync(piPath)).toBe(false);
    });

    it("leaves other writes untouched", () => {
      installPiTuiLogRedirect();
      const otherPath = join(tmpHome, "other.log");
      fs.writeFileSync(otherPath, "other data");
      expect(fs.readFileSync(otherPath, "utf8")).toBe("other data");
    });

    it("install/uninstall are idempotent", () => {
      installPiTuiLogRedirect();
      expect(isPiTuiLogRedirectInstalled()).toBe(true);
      installPiTuiLogRedirect();
      expect(isPiTuiLogRedirectInstalled()).toBe(true);
      uninstallPiTuiLogRedirect();
      expect(isPiTuiLogRedirectInstalled()).toBe(false);
      uninstallPiTuiLogRedirect();
      expect(isPiTuiLogRedirectInstalled()).toBe(false);
    });
  });
});
