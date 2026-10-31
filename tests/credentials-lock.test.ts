import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getApiKey,
  getCredentialsFilePath,
  releaseCredentialLockForTests,
  resetCredentialStoreForTests,
  setApiKey,
  setBeforeStaleLockRenameForTests,
  setLockIdentityForTests,
  setLockLinkSyncForTests,
  tryAcquireCredentialLockForTests,
} from "../src/credentials.js";
import { PraanaLogger, setAppLogger } from "../src/logger.js";

const HOST = "local-host";
const BOOT = "boot-1";

function storeLock(): string {
  return `${getCredentialsFilePath()}.lock`;
}

function refreshLock(): string {
  return `${getCredentialsFilePath()}.refresh-openai-codex.lock`;
}

function lockFile(kind: "store" | "refresh"): string {
  return kind === "store" ? storeLock() : refreshLock();
}

describe("credential lock takeover", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "praana-lock-"));
    prevHome = process.env.PRAANA_HOME;
    process.env.PRAANA_HOME = home;
    setAppLogger(new PraanaLogger({ domain: "credentials", writeLine: () => {} }));
    resetCredentialStoreForTests();
    setLockIdentityForTests({ host: HOST, bootId: BOOT });
  });

  afterEach(() => {
    resetCredentialStoreForTests();
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = prevHome;
  });

  function writeLock(kind: "store" | "refresh", raw: string): string {
    const path = lockFile(kind);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, raw, { mode: 0o600 });
    return path;
  }

  const localStale = () => JSON.stringify({
    pid: 2_147_483_646,
    startedAt: Date.now() - 120_000,
    host: HOST,
    bootId: BOOT,
  });

  it.each(["store", "refresh"] as const)(
    "keeps exactly one holder when a second %s takeover finishes between the check and the rename",
    (kind) => {
      const path = writeLock(kind, localStale());
      let holder: string | undefined;
      setBeforeStaleLockRenameForTests((seen) => {
        expect(seen).toBe(path);
        setBeforeStaleLockRenameForTests(null);
        expect(tryAcquireCredentialLockForTests(kind)).toBe(true);
        holder = readFileSync(path, "utf8");
      });
      expect(tryAcquireCredentialLockForTests(kind)).toBe(false);
      expect(holder).toBeDefined();
      expect(readFileSync(path, "utf8")).toBe(holder);
      expect((JSON.parse(holder!) as { pid: number }).pid).toBe(process.pid);
      expect(readdirSync(dirname(path)).filter((name) => name.includes(".stale."))).toEqual([]);
      releaseCredentialLockForTests(kind);
      expect(existsSync(path)).toBe(false);
      releaseCredentialLockForTests(kind);
      expect(existsSync(path)).toBe(false);
    },
  );

  it("retries acquisition when the stale lock disappears before the rename", () => {
    const path = writeLock("store", localStale());
    setBeforeStaleLockRenameForTests((seen) => {
      setBeforeStaleLockRenameForTests(null);
      unlinkSync(seen);
    });
    expect(tryAcquireCredentialLockForTests("store")).toBe(true);
    expect((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid).toBe(process.pid);
    releaseCredentialLockForTests("store");
  });

  it.each(["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"] as const)(
    "writes a credential when linkSync fails with %s",
    (code) => {
      setLockLinkSyncForTests(() => {
        throw Object.assign(new Error("hard links unsupported"), { code });
      });
      setApiKey("openrouter", `sk-${code}`);
      expect(getApiKey("openrouter")).toBe(`sk-${code}`);
      expect(existsSync(storeLock())).toBe(false);
      expect(readdirSync(home).filter((name) => name.startsWith(".credlock."))).toEqual([]);
    },
  );

  it("does not replace a live lock when linkSync reports EEXIST", () => {
    const raw = JSON.stringify({ pid: process.pid, startedAt: Date.now(), host: HOST, bootId: BOOT });
    const path = writeLock("store", raw);
    setLockLinkSyncForTests(() => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    });
    expect(tryAcquireCredentialLockForTests("store")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("does not take a fresh lock whose host does not match", () => {
    const raw = JSON.stringify({
      pid: 2_147_483_646,
      startedAt: Date.now(),
      host: "other-host",
      bootId: "boot-other",
    });
    const path = writeLock("store", raw);
    expect(tryAcquireCredentialLockForTests("store")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("does not take a fresh lock whose boot id does not match", () => {
    const raw = JSON.stringify({
      pid: 2_147_483_646,
      startedAt: Date.now(),
      host: HOST,
      bootId: "other-boot",
    });
    const path = writeLock("refresh", raw);
    expect(tryAcquireCredentialLockForTests("refresh")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(raw);
  });

  it("takes a foreign lock only after it ages past 60 seconds", () => {
    const raw = JSON.stringify({
      pid: 2_147_483_646,
      startedAt: Date.now(),
      host: "other-host",
      bootId: BOOT,
    });
    const path = writeLock("store", raw);
    const stale = new Date(Date.now() - 90_000);
    utimesSync(path, stale, stale);
    expect(tryAcquireCredentialLockForTests("store")).toBe(true);
    releaseCredentialLockForTests("store");
  });

  it("takes a dead local pid when host and boot id match", () => {
    const raw = JSON.stringify({
      pid: 2_147_483_646,
      startedAt: Date.now(),
      host: HOST,
      bootId: BOOT,
    });
    writeLock("store", raw);
    expect(tryAcquireCredentialLockForTests("store")).toBe(true);
    releaseCredentialLockForTests("store");
  });

  it("trusts a dead pid when neither side has a boot id", () => {
    setLockIdentityForTests({ host: HOST, bootId: null });
    const raw = JSON.stringify({ pid: 2_147_483_646, startedAt: Date.now(), host: HOST });
    writeLock("store", raw);
    expect(tryAcquireCredentialLockForTests("store")).toBe(true);
    releaseCredentialLockForTests("store");
  });

  it("leaves a corrupt credentials file byte-identical when setApiKey cannot read it", () => {
    const path = getCredentialsFilePath();
    mkdirSync(dirname(path), { recursive: true });
    const bytes = Buffer.from("{not-json");
    writeFileSync(path, bytes, { mode: 0o600 });
    resetCredentialStoreForTests();
    setLockIdentityForTests({ host: HOST, bootId: BOOT });
    expect(() => setApiKey("openrouter", "sk-new")).toThrow(/left it unchanged/);
    expect(readFileSync(path)).toEqual(bytes);
    expect(existsSync(storeLock())).toBe(false);
  });
});
