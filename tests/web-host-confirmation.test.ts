import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { Session } from "../src/session.js";

/**
 * Regression for the OCR review finding: `turn.ts` runs tool calls with
 * Promise.all, so a batch fetching several pages from one host each passed
 * the "not remembered yet" check before any confirmation finished and the
 * user was prompted repeatedly. One prompt per host per batch.
 */
describe("web_fetch host confirmation is shared per host", () => {
  const dirs: string[] = [];

  function newSession(): Session {
    const dir = mkdtempSync(join(tmpdir(), "praana-web-host-"));
    dirs.push(dir);
    const config = loadConfig();
    config.session.log_dir = join(dir, "sessions");
    return Session.createNew("test-session", dir, config);
  }

  function makeSession(): { session: Session; prompts: string[] } {
    const session = newSession();
    const prompts: string[] = [];
    session.confirmRisk = async (_classId, prompt) => {
      prompts.push(prompt);
      // Give the other concurrent callers a chance to arrive mid-flight.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { allowed: true };
    };
    return { session, prompts };
  }

  /** Same sharing, but driven through the UI handler rather than a stub. */
  function makeHandlerSession(answer = true): { session: Session; prompts: string[] } {
    const session = newSession();
    const prompts: string[] = [];
    session.setConfirmHandler(async (message) => {
      prompts.push(message);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return answer;
    });
    return { session, prompts };
  }

  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("prompts once for concurrent fetches to the same host", async () => {
    const { session, prompts } = makeSession();
    const results = await Promise.all([
      session.confirmWebFetchHost("example.com", "Fetch example.com ? [y/N]"),
      session.confirmWebFetchHost("example.com", "Fetch example.com ? [y/N]"),
      session.confirmWebFetchHost("example.com", "Fetch example.com ? [y/N]"),
    ]);
    expect(results.every((r) => r.allowed)).toBe(true);
    expect(prompts).toHaveLength(1);
  });

  it("does not prompt again after the host is remembered", async () => {
    const { session, prompts } = makeSession();
    await session.confirmWebFetchHost("example.com", "first");
    await session.confirmWebFetchHost("example.com", "second");
    expect(prompts).toHaveLength(1);
    expect(session.webFetchHostRemembered("example.com")).toBe(true);
  });

  it("prompts separately for different hosts", async () => {
    const { session, prompts } = makeSession();
    await Promise.all([
      session.confirmWebFetchHost("a.example", "a"),
      session.confirmWebFetchHost("b.example", "b"),
    ]);
    expect(prompts).toHaveLength(2);
  });

  it("a decline is shared and does not remember the host", async () => {
    const { session, prompts } = makeSession();
    session.confirmRisk = async (_classId, prompt) => {
      prompts.push(prompt);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { allowed: false, reason: "declined" };
    };
    const [a, b] = await Promise.all([
      session.confirmWebFetchHost("example.com", "x"),
      session.confirmWebFetchHost("example.com", "x"),
    ]);
    expect(a.allowed).toBe(false);
    expect(b.allowed).toBe(false);
    expect(prompts).toHaveLength(1);
    expect(session.webFetchHostRemembered("example.com")).toBe(false);
  });

  it("shares one handler prompt and remembers an allowed host", async () => {
    const { session, prompts } = makeHandlerSession();
    const results = await Promise.all([
      session.confirmWebFetchHost("example.com", "Fetch example.com? [y/N]"),
      session.confirmWebFetchHost("example.com", "Fetch example.com? [y/N]"),
    ]);
    expect(results).toEqual([{ allowed: true }, { allowed: true }]);
    expect(prompts).toEqual(["Fetch example.com? [y/N]"]);
    expect(session.webFetchHostRemembered("example.com")).toBe(true);
    // Remembered: no second prompt for the same host.
    expect(await session.confirmWebFetchHost("example.com", "again")).toEqual({ allowed: true });
    expect(prompts).toHaveLength(1);
  });

  it("a handler decline is shared and does not remember the host", async () => {
    const { session, prompts } = makeHandlerSession(false);
    const [a, b] = await Promise.all([
      session.confirmWebFetchHost("example.com", "x"),
      session.confirmWebFetchHost("example.com", "x"),
    ]);
    expect(a).toEqual({ allowed: false, reason: "declined" });
    expect(b).toEqual({ allowed: false, reason: "declined" });
    expect(prompts).toHaveLength(1);
    expect(session.webFetchHostRemembered("example.com")).toBe(false);
  });
});
