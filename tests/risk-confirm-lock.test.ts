/**
 * Risk confirmations: the lock, the UI handler, and the readline fallback.
 *
 * `Session.confirmRisk` serialises through one lock so two tools that ask at
 * once cannot draw two prompts. A UI handler (the TUI overlay) replaces the
 * readline prompt; with no handler the classic `promptYesNo` path is kept.
 * The headless branch never prompts.
 */
import { afterAll, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { createConfirmLock } from "../src/risk/confirm-lock.js";
import * as prompt from "../src/risk/prompt.js";
import { Session } from "../src/session.js";
import type { PraanaLogger } from "../src/logger.js";

const dirs: string[] = [];

function makeSession(): Session {
  const dir = mkdtempSync(join(tmpdir(), "praana-risk-confirm-"));
  dirs.push(dir);
  const config = loadConfig();
  config.session.log_dir = join(dir, "sessions");
  return Session.createNew("test-session", dir, config);
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("Session.confirmRisk", () => {
  it("uses the UI handler instead of the readline prompt", async () => {
    const session = makeSession();
    const spy = spyOn(prompt, "promptYesNo");
    const seen: string[] = [];
    session.setConfirmHandler(async (message) => {
      seen.push(message);
      return true;
    });

    expect(await session.confirmRisk("destructive", "destructive: rm -rf tmp")).toEqual({
      allowed: true,
    });
    expect(seen).toEqual(["destructive: rm -rf tmp"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("treats a handler that answers no as declined", async () => {
    const session = makeSession();
    session.setConfirmHandler(async () => false);
    expect(await session.confirmRisk("package_install", "package_install: npm i x")).toEqual({
      allowed: false,
      reason: "declined",
    });
  });

  it("treats a handler that throws as declined", async () => {
    const session = makeSession();
    session.setConfirmHandler(async () => {
      throw new Error("overlay closed");
    });
    expect(await session.confirmRisk("destructive", "rm -rf tmp")).toEqual({
      allowed: false,
      reason: "declined",
    });
  });

  it("logs a handler failure with the risk class before declining", async () => {
    const session = makeSession();
    session.setConfirmHandler(async () => {
      throw new Error("overlay closed");
    });
    // The session logger is built lazily, so intercept the one entry point.
    const warn = mock(() => {});
    const logger = { child: () => ({ warn }) } as unknown as PraanaLogger;
    spyOn(session, "getLogger").mockReturnValue(logger);
    expect(await session.confirmRisk("web_fetch_host", "Fetch example.com? [y/N]")).toEqual({
      allowed: false,
      reason: "declined",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, opts] = warn.mock.calls[0] as [
      string,
      { details?: { class?: string }; cause?: Error },
    ];
    expect(message).toContain("Risk confirmation failed");
    expect(opts.details?.class).toBe("web_fetch_host");
    expect(opts.cause?.message).toBe("overlay closed");
  });

  it("serialises concurrent confirmations through the lock", async () => {
    const session = makeSession();
    const events: string[] = [];
    session.setConfirmHandler(async (message) => {
      events.push(`start:${message}`);
      if (message === "first") await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`end:${message}`);
      return true;
    });

    const [a, b] = await Promise.all([
      session.confirmRisk("destructive", "first"),
      session.confirmRisk("destructive", "second"),
    ]);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("falls back to the readline prompt when the handler is cleared", async () => {
    const session = makeSession();
    const spy = spyOn(prompt, "promptYesNo").mockResolvedValue(true);
    session.setConfirmHandler(async () => false);
    session.setConfirmHandler(null);
    expect(await session.confirmRisk("destructive", "rm -rf tmp")).toEqual({ allowed: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("rm -rf tmp");
    spy.mockRestore();
  });

  it("keeps the headless branch and never calls the handler", async () => {
    const session = makeSession();
    session.headless = true;
    let calls = 0;
    session.setConfirmHandler(async () => {
      calls += 1;
      return true;
    });

    expect(await session.confirmRisk("destructive", "rm -rf tmp")).toEqual({
      allowed: false,
      reason: "headless",
    });
    session.config.risk = { ...session.config.risk, allow: ["destructive"] };
    expect(await session.confirmRisk("destructive", "rm -rf tmp")).toEqual({ allowed: true });
    expect(calls).toBe(0);
  });
});

describe("createConfirmLock", () => {
  it("runs overlapping calls in start order", async () => {
    const lock = createConfirmLock();
    const order: number[] = [];
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const a = lock(async () => {
      await wait(30);
      order.push(1);
      return 1;
    });
    const b = lock(async () => {
      order.push(2);
      return 2;
    });
    expect(await Promise.all([a, b])).toEqual([1, 2]);
    expect(order).toEqual([1, 2]);
  });

  it("releases the lock when the first call rejects", async () => {
    const lock = createConfirmLock();
    const first = lock(async () => {
      throw new Error("boom");
    });
    const second = lock(async () => "ok");
    await expect(first).rejects.toThrow("boom");
    expect(await second).toBe("ok");
  });
});
