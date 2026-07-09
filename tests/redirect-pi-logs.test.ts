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
  rewritePiTuiCrashErrorMessage,
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

    it("normalizes redundant slashes", () => {
      const target = getPiTuiLogRedirectTarget("/home/user/.pi/agent//pi-crash.log");
      expect(target).toEndWith("/.praana/logs/pi-crash.log");
    });

    it("normalizes relative path segments", () => {
      const target = getPiTuiLogRedirectTarget("/home/user/.pi/agent/../agent/pi-crash.log");
      expect(target).toEndWith("/.praana/logs/pi-crash.log");
    });

    it("matches Windows-style backslash paths", () => {
      const target = getPiTuiLogRedirectTarget("C:\\Users\\user\\.pi\\agent\\pi-crash.log");
      expect(target).toEndWith("/.praana/logs/pi-crash.log");
    });

    it("rejects paths whose final directory is not .pi/agent", () => {
      expect(getPiTuiLogRedirectTarget("/home/user/.pi/other/pi-crash.log")).toBeUndefined();
      expect(getPiTuiLogRedirectTarget("/home/user/.praana/logs/pi-crash.log")).toBeUndefined();
    });
  });

  describe("rewritePiTuiCrashErrorMessage", () => {
    it("rewrites the crash log path in pi-tui error messages", () => {
      const original = "Fatal: TUI crashed. Debug log written to: /home/user/.pi/agent/pi-crash.log";
      const rewritten = rewritePiTuiCrashErrorMessage(original);
      expect(rewritten).toEndWith("/.praana/logs/pi-crash.log");
      expect(rewritten).not.toInclude("/.pi/agent/");
    });

    it("leaves unrelated messages unchanged", () => {
      const msg = "Something else went wrong";
      expect(rewritePiTuiCrashErrorMessage(msg)).toBe(msg);
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

    it("redirects fs.promises.writeFile for the crash log", async () => {
      installPiTuiLogRedirect();
      const piPath = join(tmpHome, ".pi", "agent", "pi-crash.log");
      await fs.promises.writeFile(piPath, "promise crash data");
      const praanaPath = join(tmpHome, ".praana", "logs", "pi-crash.log");
      expect(fs.existsSync(praanaPath)).toBe(true);
      expect(fs.readFileSync(praanaPath, "utf8")).toBe("promise crash data");
      expect(fs.existsSync(piPath)).toBe(false);
    });

    it("redirects fs.promises.appendFile for the debug log", async () => {
      installPiTuiLogRedirect();
      const piPath = join(tmpHome, ".pi", "agent", "pi-debug.log");
      await fs.promises.appendFile(piPath, "promise line 1\n");
      await fs.promises.appendFile(piPath, "promise line 2\n");
      const praanaPath = join(tmpHome, ".praana", "logs", "pi-debug.log");
      expect(fs.existsSync(praanaPath)).toBe(true);
      expect(fs.readFileSync(praanaPath, "utf8")).toBe("promise line 1\npromise line 2\n");
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

    it("restores fs.promises methods on uninstall", async () => {
      installPiTuiLogRedirect();
      uninstallPiTuiLogRedirect();
      const piAgentDir = join(tmpHome, ".pi", "agent");
      fs.mkdirSync(piAgentDir, { recursive: true });
      const piPath = join(piAgentDir, "pi-crash.log");
      fs.writeFileSync(piPath, "should stay here");
      expect(fs.existsSync(piPath)).toBe(true);
      await fs.promises.appendFile(join(piAgentDir, "pi-debug.log"), "should stay");
      expect(fs.existsSync(join(piAgentDir, "pi-debug.log"))).toBe(true);
    });
  });
});
