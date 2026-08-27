import { describe, it, expect, beforeEach } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  PraanaLogger,
  createSessionLogger,
  createTestLogger,
  extractLlmErrorMessage,
  formatUserFacingLlmError,
  friendlyLlmError,
  parseLlmError,
  getAppLogger,
  getSessionSystemLogPath,
  LOG_RETENTION_DAYS,
  LOG_RETENTION_COUNT,
  refreshCurrentLogSymlink,
  setAppLogger,
} from "../src/logger.js";

describe("logger", () => {
  beforeEach(() => {
    setAppLogger(new PraanaLogger({ domain: "app", writeLine: () => {} }));
  });

  it("writes warn/error lines to the test sink", () => {
    const lines: string[] = [];
    const log = createTestLogger((line) => lines.push(line));

    log.warn("something odd", { code: "CONFIG_INVALID" });
    log.error("something broke", { code: "UNKNOWN" });

    expect(lines.length).toBe(2);
    expect(lines.some((l) => l.includes("something odd"))).toBe(true);
    expect(lines.some((l) => l.includes("something broke"))).toBe(true);
  });

  it("writes session diagnostics to current.log (not events.jsonl)", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-syslog-"));
    const sessionLogDir = join(root, "sessions");
    const sessionId = "sess-log-test";
    const prevVitest = process.env.VITEST;
    const prevNodeEnv = process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;

    try {
      const log = await createSessionLogger({
        sessionId,
        sessionLogDir,
        debug: false,
      });
      log.child("llm").error("LLM stream error", {
        code: "LLM_STREAM_ERROR",
        details: { model: "test/model", provider: "openrouter" },
      });

      const systemLogPath = getSessionSystemLogPath(sessionLogDir, sessionId);
      expect(lstatSync(systemLogPath).isSymbolicLink()).toBe(true);
      const systemLog = readFileSync(systemLogPath, "utf-8");
      expect(systemLog).toContain("LLM stream error");
      expect(systemLog).toContain("LLM_STREAM_ERROR");
    } finally {
      if (prevVitest !== undefined) process.env.VITEST = prevVitest;
      else delete process.env.VITEST;
      if (prevNodeEnv !== undefined) process.env.NODE_ENV = prevNodeEnv;
      else delete process.env.NODE_ENV;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refreshCurrentLogSymlink creates a current.log symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-symlink-"));
    try {
      const target = join(dir, "praana.2026-07-17.1.log");
      writeFileSync(target, "log body");
      refreshCurrentLogSymlink(dir, target);
      expect(lstatSync(join(dir, "current.log")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dir, "current.log"))).toBe("praana.2026-07-17.1.log");
      expect(readFileSync(join(dir, "current.log"), "utf-8")).toBe("log body");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshCurrentLogSymlink is idempotent for the same target", () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-symlink-"));
    try {
      const target = join(dir, "praana.2026-07-17.1.log");
      writeFileSync(target, "log body");
      refreshCurrentLogSymlink(dir, target);
      refreshCurrentLogSymlink(dir, target);
      expect(lstatSync(join(dir, "current.log")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dir, "current.log"))).toBe("praana.2026-07-17.1.log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshCurrentLogSymlink updates a stale symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-symlink-"));
    try {
      const oldTarget = join(dir, "old.log");
      const newTarget = join(dir, "new.log");
      writeFileSync(oldTarget, "old");
      writeFileSync(newTarget, "new");
      refreshCurrentLogSymlink(dir, oldTarget);
      expect(readlinkSync(join(dir, "current.log"))).toBe("old.log");
      refreshCurrentLogSymlink(dir, newTarget);
      expect(readlinkSync(join(dir, "current.log"))).toBe("new.log");
      expect(readFileSync(join(dir, "current.log"), "utf-8")).toBe("new");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("initAppLogFile survives two concurrent processes sharing PRAANA_HOME", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-concurrent-init-"));
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    const fixture = fileURLToPath(new URL("./fixtures/concurrent-log-init.ts", import.meta.url));

    const env: Record<string, string | undefined> = { ...process.env, PRAANA_HOME: home };
    delete env.VITEST;

    const children = [1, 2].map(() => {
      return new Promise<{ code: number | null; stderr: string }>((resolve) => {
        const child = spawn("bun", [fixture], {
          env,
          cwd: process.cwd(),
        });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("close", (code) => resolve({ code, stderr }));
      });
    });

    const results = await Promise.all(children);
    for (const result of results) {
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("EEXIST");
    }

    const currentLog = join(home, ".praana", "logs", "current.log");
    expect(lstatSync(currentLog).isSymbolicLink()).toBe(true);
    const target = readlinkSync(currentLog);
    expect(existsSync(join(home, ".praana", "logs", target))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("captures log output without writing it to stderr when a TUI sink is active", () => {
    const lines: string[] = [];
    const logger = new PraanaLogger({
      domain: "llm",
      writeLine: (line) => lines.push(line),
    });

    logger.error("LLM stream error", { code: "LLM_STREAM_ERROR" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("LLM stream error");
  });

  it("notice() does not write stderr when suppressStderr is true", () => {
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr.write as typeof process.stderr.write) = ((
      chunk: string | Uint8Array,
      encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
      cb?: (err?: Error | null) => void,
    ) => {
      writes.push(String(chunk));
      if (typeof encodingOrCb === "function") encodingOrCb();
      else cb?.();
      return true;
    }) as typeof process.stderr.write;

    try {
      const log = new PraanaLogger({ domain: "app", suppressStderr: true });
      log.notice("embedder: keyword-only (model download skipped)");
      expect(writes.join("")).not.toContain("keyword-only");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("extracts pi-ai error messages", () => {
    expect(
      extractLlmErrorMessage({ errorMessage: "401 Unauthorized" }),
    ).toBe("401 Unauthorized");
    expect(
      extractLlmErrorMessage({
        content: [{ type: "text", text: "rate limited" }],
      }),
    ).toBe("rate limited");
    expect(extractLlmErrorMessage(null)).toBeUndefined();
  });

  it("formats user-facing LLM errors with provider detail", () => {
    expect(
      formatUserFacingLlmError({
        reason: "error",
        llmMessage: "401 Unauthorized",
        model: "m",
        provider: "openrouter",
      }),
    ).toBe("[LLM error: 401 Unauthorized]");

    expect(
      formatUserFacingLlmError({
        reason: "stop",
        model: "m",
        provider: "openrouter",
      }),
    ).toContain("no response from model");
  });

  it("parseLlmError extracts status and human message from provider JSON", () => {
    expect(
      parseLlmError('403: {"type":"account_suspended","message":"Your account has been cancelled.","reason":"cancellation_effective"}'),
    ).toEqual({
      status: 403,
      message: "Your account has been cancelled.",
      type: "account_suspended",
    });
    expect(parseLlmError("401 Unauthorized")).toEqual({});
    expect(parseLlmError("")).toEqual({});
    expect(parseLlmError(undefined)).toEqual({});
  });

  it("friendlyLlmError collapses raw JSON into a short actionable line", () => {
    const friendly = friendlyLlmError(
      '403: {"type":"account_suspended","message":"Your account has been cancelled. Visit https://umans.ai/billing to reactivate.","reason":"cancellation_effective"}',
    );
    expect(friendly).toContain("Your account has been cancelled");
    expect(friendly).toContain("reactivate");
    expect(friendly!.length).toBeLessThan(200);
    // Plain text passes through unchanged.
    expect(friendlyLlmError("401 Unauthorized")).toBe("401 Unauthorized");
    expect(friendlyLlmError(undefined)).toBeUndefined();
  });

  it("formatUserFacingLlmError uses friendly text for JSON payloads", () => {
    const out = formatUserFacingLlmError({
      reason: "error",
      llmMessage:
        '403: {"type":"account_suspended","message":"Your account has been cancelled.","reason":"cancellation_effective"}',
      model: "m",
      provider: "openrouter",
    });
    expect(out).toContain("Your account has been cancelled");
    expect(out).not.toContain('"type"');
    expect(out).not.toContain("account_suspended");
  });

  it("exposes a shared app logger", () => {
    expect(getAppLogger()).toBeInstanceOf(PraanaLogger);
  });
  it("keeps 15 days of daily rotated logs", () => {
    expect(LOG_RETENTION_DAYS).toBe(15);
    expect(LOG_RETENTION_COUNT).toBe(14);
  });
});
