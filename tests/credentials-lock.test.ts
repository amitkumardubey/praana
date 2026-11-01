import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireAsync,
  acquireSync,
  CredentialLockTimeoutError,
  lockFileIsReplaceableForTests,
  type CredentialLock,
} from "../src/credential-lock.js";
import {
  credentialLockPathForTests,
  getApiKey,
  getCredentialsFilePath,
  resetCredentialStoreForTests,
  setApiKey,
} from "../src/credentials.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";

/**
 * Removal table for the advisory-lock design. Each row is a protection that
 * the named checks fail without. The list under "not caught" is what these
 * tests cannot prove.
 *
 * | Protection | Removed, this fails | Not caught |
 * |---|---|---|
 * | Advisory lock (OS releases on death) | "a killed holder is acquirable within a short bound, 20 times" | Network filesystems where advisory locks are ignored; Windows LockFileEx; a kill after the token server has rotated and before the new credential is renamed into place |
 * | In-process single connection | "a second contender waits, then enters on release" and "abort ends only the waiter" | A native thread opening the same database outside this module |
 * | Single-flight refresh | oauth-refresh "uses one refresh for two concurrent callers" | Two processes that both pass the lock and then both post, if the lock were released before the request |
 * | Compare-and-set before commit | oauth-refresh "does not let an in-flight refresh undo logout" | A logout that lands in the same process inside the synchronous store section (the section does not await) |
 * | Re-read inside the lock | oauth-refresh "keeps another provider written during a refresh" and the seeded interleaving | A writer that bypasses the credential module and edits the file with the lock held |
 * | Persist before releasing the refresh lock | "two processes refresh once" in oauth-refresh | The process being killed after the server accepts the rotation and before the rename |
 * | Abort isolation | oauth-refresh "persists a rotation that succeeds after the caller cancels" and the seeded abort check | An abort that arrives before the shared refresh is started (that one is supposed to skip the refresh) |
 * | Corrupt-store protection | "leaves a corrupt credentials file byte-identical" | A credentials file that changes from valid JSON to garbage while a refresh request is already in flight, after the locked re-read |
 */
describe("credential advisory locks", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "praana-lock-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = home;
    setAppLogger(new PraanaLogger({ domain: "credentials", writeLine: () => {} }));
    resetCredentialStoreForTests();
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  function pathFor(kind: "store" | "refresh"): string {
    return credentialLockPathForTests(kind);
  }

  it.each(["store", "refresh"] as const)(
    "a second %s contender waits while the first holds, then enters on release",
    async (kind) => {
      const path = pathFor(kind);
      const first = acquireSync(path, { waitMs: 0 });
      let entered = false;
      const second = acquireAsync(path, { waitMs: 2_000, pollMs: 100 }).then((lock) => {
        entered = true;
        lock.release();
      });
      await Bun.sleep(40);
      expect(entered).toBe(false);
      first.release();
      first.release();
      await second;
      expect(entered).toBe(true);
    },
  );

  it("does not block the event loop while an async acquire waits", async () => {
    const path = pathFor("refresh");
    const first = acquireSync(path, { waitMs: 0 });
    let ticked = false;
    const timer = setTimeout(() => { ticked = true; }, 20);
    const pending = acquireAsync(path, { waitMs: 1_000, pollMs: 100 });
    await Bun.sleep(50);
    expect(ticked).toBe(true);
    clearTimeout(timer);
    first.release();
    (await pending).release();
  });

  it("abort ends only the waiter", async () => {
    const path = pathFor("refresh");
    const first = acquireSync(path, { waitMs: 0 });
    const ctl = new AbortController();
    const waiter = acquireAsync(path, { waitMs: 5_000, signal: ctl.signal, pollMs: 100 });
    const settled = waiter.then(
      () => "acquired" as const,
      (err: unknown) => err,
    );
    await Bun.sleep(30);
    ctl.abort();
    const aborted = await settled;
    expect(aborted).toBeInstanceOf(Error);
    if (!(aborted instanceof Error)) return;
    expect(aborted.name).toBe("AbortError");
    await expect(acquireAsync(path, { waitMs: 0, pollMs: 100 })).rejects.toBeInstanceOf(CredentialLockTimeoutError);
    first.release();
    const after = acquireSync(path, { waitMs: 0 });
    after.release();
  });

  it("maps a timed-out acquire to the credential lock timeout error", async () => {
    const path = pathFor("store");
    const first = acquireSync(path, { waitMs: 0 });
    try {
      const pending = acquireAsync(path, { waitMs: 0, pollMs: 100 });
      await expect(pending).rejects.toBeInstanceOf(CredentialLockTimeoutError);
      await expect(pending).rejects.toThrow(/Timed out waiting for the credential lock/);
    } finally {
      first.release();
    }
  });

  it("does not take over a live lock because its file is old", () => {
    const path = pathFor("store");
    const first = acquireSync(path, { waitMs: 0 });
    try {
      const aged = new Date(Date.now() - 90_000);
      utimesSync(path, aged, aged);
      expect(() => acquireSync(path, { waitMs: 0 })).toThrow(CredentialLockTimeoutError);
    } finally {
      first.release();
    }
    const after = acquireSync(path, { waitMs: 0 });
    after.release();
  });

  it("sanitizes the provider id in the refresh lock name", () => {
    expect(credentialLockPathForTests("refresh", "a/b c")).toMatch(/credentials\.refresh-a_b_c\.lock\.db$/);
    expect(credentialLockPathForTests("store")).toMatch(/credentials\.lock\.db$/);
  });

  it("a killed holder is acquirable within a short bound, 20 times", async () => {
    const path = pathFor("refresh");
    const script = join(home, "holder.ts");
    const lockUrl = pathToFileURL(join(import.meta.dir, "../src/credential-lock.ts")).href;
    writeFileSync(script, `
      import { writeFileSync } from "node:fs";
      import { acquireSync } from ${JSON.stringify(lockUrl)};
      const handle = acquireSync(process.argv[2], { waitMs: 0 });
      (globalThis as { __lock?: unknown }).__lock = handle;
      writeFileSync(process.argv[3], "1");
      setInterval(() => {}, 1000);
    `);
    for (let i = 0; i < 20; i++) {
      const ready = join(home, `ready-${i}`);
      const child: ChildProcess = spawn(process.execPath, [script, path, ready], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += String(chunk); });
      try {
        const deadline = Date.now() + 8_000;
        while (!existsSync(ready)) {
          if (child.exitCode !== null) throw new Error(`holder exited early: ${stderr}`);
          if (Date.now() > deadline) throw new Error(`ready timeout: ${stderr}`);
          await Bun.sleep(5);
        }
        child.kill("SIGKILL");
        await new Promise((resolve) => child.on("exit", resolve));
        const started = Date.now();
        const lock: CredentialLock = acquireSync(path, { waitMs: 1_000 });
        expect(Date.now() - started).toBeLessThan(1_000);
        lock.release();
      } catch (err) {
        child.kill("SIGKILL");
        throw err;
      }
    }
  }, { timeout: 60_000 });

  it("does not treat an empty or replaced lock file as replaceable", () => {
    const path = pathFor("refresh");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    const empty = statSync(path);
    expect(lockFileIsReplaceableForTests(path, { dev: empty.dev, ino: empty.ino })).toBe(false);
    writeFileSync(path, "this is not a sqlite database");
    const corrupt = statSync(path);
    expect(lockFileIsReplaceableForTests(path, { dev: corrupt.dev, ino: corrupt.ino })).toBe(true);
    expect(lockFileIsReplaceableForTests(path, { dev: corrupt.dev, ino: corrupt.ino + 1 })).toBe(false);
  });

  it("times out an in-process waiter when waitMs elapses", async () => {
    const path = pathFor("refresh");
    const first = await acquireAsync(path, { waitMs: 0, pollMs: 100 });
    try {
      const outcome = await Promise.race([
        acquireAsync(path, { waitMs: 40, pollMs: 100 }).then(() => "acquired" as const, (err: unknown) => err),
        Bun.sleep(300).then(() => "pending" as const),
      ]);
      expect(outcome).toBeInstanceOf(CredentialLockTimeoutError);
    } finally {
      first.release();
    }
  });

  it("recreates a corrupt lock database instead of waiting out the timeout", () => {
    const path = pathFor("refresh");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "this is not a sqlite database");
    const started = Date.now();
    const lock = acquireSync(path, { waitMs: 1_500 });
    expect(Date.now() - started).toBeLessThan(500);
    lock.release();
    const again = acquireSync(path, { waitMs: 0 });
    again.release();
  });

  it("fails clearly when a corrupt lock database cannot be replaced", () => {
    const path = pathFor("store");
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "this is not a sqlite database");
    chmodSync(dir, 0o500);
    try {
      const started = Date.now();
      expect(() => acquireSync(path, { waitMs: 1_500 })).toThrow(/corrupt/i);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  it("moves a corrupt credentials file aside so a later save can start fresh", () => {
    const path = getCredentialsFilePath();
    mkdirSync(join(path, ".."), { recursive: true });
    const bytes = Buffer.from("{not-json");
    writeFileSync(path, bytes, { mode: 0o600 });
    resetCredentialStoreForTests();
    setApiKey("openrouter", "sk-new");
    expect(getApiKey("openrouter")).toBe("sk-new");
    expect(readFileSync(path, "utf8")).toContain("sk-new");
    const backups = readdirSync(join(path, "..")).filter((name) => name.startsWith("credentials.json.corrupt-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(path, "..", backups[0]!))).toEqual(bytes);
    const lock = acquireSync(credentialLockPathForTests("store"), { waitMs: 0 });
    lock.release();
  });
});
