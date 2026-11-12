/**
 * `Session.confirmAction` (issue #748) — the confirmation path that
 * `edit_file` and `git_commit` use.
 *
 * It is not a risk class: no `[risk].allow` entry can permit it, and it never
 * looks at the risk list. It shares the risk path's lock and handler, falls
 * back to `promptYesNo` with no handler, and denies when headless instead of
 * blocking on a prompt that no one can see.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import * as prompt from "../src/risk/prompt.js";
import { Session } from "../src/session.js";

const dirs: string[] = [];

function makeSession(): Session {
  const dir = mkdtempSync(join(tmpdir(), "praana-action-lock-"));
  dirs.push(dir);
  const config = loadConfig();
  config.session.log_dir = join(dir, "sessions");
  return Session.createNew("test-session", dir, config);
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("Session.confirmAction", () => {
  it("uses the UI handler instead of the readline prompt", async () => {
    const session = makeSession();
    const spy = spyOn(prompt, "promptYesNo");
    const seen: string[] = [];
    session.setConfirmHandler(async (message) => {
      seen.push(message);
      return true;
    });
    expect(await session.confirmAction({ question: "Apply edit?", preview: [] })).toEqual({ allowed: true });
    expect(seen).toEqual(["Apply edit?"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("treats a handler that answers no as declined", async () => {
    const session = makeSession();
    session.setConfirmHandler(async () => false);
    expect(await session.confirmAction({ question: "Apply edit?", preview: [] })).toEqual({
      allowed: false,
      reason: "declined",
    });
  });

  it("treats a handler that throws as declined", async () => {
    const session = makeSession();
    session.setConfirmHandler(async () => {
      throw new Error("overlay closed");
    });
    expect(await session.confirmAction({ question: "Apply edit?", preview: [] })).toEqual({
      allowed: false,
      reason: "declined",
    });
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
      session.confirmAction({ question: "first", preview: [] }),
      session.confirmAction({ question: "second", preview: [] }),
    ]);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(events).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("serialises against risk confirmations on the same lock", async () => {
    const session = makeSession();
    const events: string[] = [];
    session.setConfirmHandler(async (message) => {
      events.push(`start:${message}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(`end:${message}`);
      return true;
    });
    await Promise.all([
      session.confirmRisk("rm", "risk"),
      session.confirmAction({ question: "action", preview: [] }),
    ]);
    // Whichever starts first must finish before the other draws a prompt.
    expect(events).toHaveLength(4);
    expect(events[0]?.startsWith("start:")).toBe(true);
    expect(events[1]).toBe(events[0]?.replace("start:", "end:"));
  });

  it("falls back to the readline prompt when the handler is cleared", async () => {
    const session = makeSession();
    const spy = spyOn(prompt, "promptYesNo").mockResolvedValue(true);
    session.setConfirmHandler(async () => false);
    session.setConfirmHandler(null);
    expect(await session.confirmAction({ question: "Apply edit?", preview: [] })).toEqual({ allowed: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("Apply edit?");
    spy.mockRestore();
  });

  it("denies in a headless session without prompting, even when risk.allow lists everything", async () => {
    const session = makeSession();
    session.headless = true;
    let calls = 0;
    session.setConfirmHandler(async () => {
      calls += 1;
      return true;
    });
    const spy = spyOn(prompt, "promptYesNo");
    session.config.risk = { ...session.config.risk, allow: ["edit_file", "git_commit"] };
    expect(await session.confirmAction({ question: "Apply edit?", preview: [] })).toEqual({
      allowed: false,
      reason: "headless",
    });
    expect(calls).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
