import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PraanaLogger,
  createSessionLogger,
  createTestLogger,
  extractLlmErrorMessage,
  formatUserFacingLlmError,
  getAppLogger,
  getSessionSystemLogPath,
  LOG_RETENTION_DAYS,
  LOG_RETENTION_COUNT,
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
    const root = mkdtempSync(join(tmpdir(), "aria-syslog-"));
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

  it("exposes a shared app logger", () => {
    expect(getAppLogger()).toBeInstanceOf(PraanaLogger);
  });

  it("keeps 15 days of daily rotated logs", () => {
    expect(LOG_RETENTION_DAYS).toBe(15);
    expect(LOG_RETENTION_COUNT).toBe(14);
  });
});
