import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, utimesSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EVENT_LOG_FILENAME, findLatestSessionForCwd, resolveSessionId } from "../src/event-log.js";
import { AmbiguousSessionPrefixError } from "../src/session-errors.js";
import type { SessionMeta } from "../src/types.js";

const testLogDir = mkdtempSync(join(tmpdir(), "praana-test-session-resolver-"));

function writeMeta(sessionId: string, meta: Partial<SessionMeta> & Pick<SessionMeta, "cwd">): void {
  const dir = join(testLogDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const full: SessionMeta = {
    session_id: sessionId,
    started_at: meta.started_at ?? Date.now(),
    cwd: meta.cwd,
    agent: meta.agent ?? "praana",
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(full, null, 2) + "\n");
}

function writeEvents(sessionId: string, mtimeMs: number): void {
  const path = join(testLogDir, sessionId, EVENT_LOG_FILENAME);
  writeFileSync(path, "{}\n");
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

describe("findLatestSessionForCwd", () => {
  beforeEach(() => {
    mkdirSync(testLogDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testLogDir, { recursive: true, force: true });
  });

  it("returns null when log directory does not exist", () => {
    const missing = join(tmpdir(), "praana-missing-log-dir-" + Date.now());
    expect(findLatestSessionForCwd(missing, "/tmp")).toBeNull();
  });

  it("returns null when no sessions match cwd", () => {
    writeMeta("01OLDER000000000000000001", { cwd: "/other/project" });
    expect(findLatestSessionForCwd(testLogDir, "/home/user/praana")).toBeNull();
  });

  it("returns the newest session for the same cwd", () => {
    const cwd = resolve("/home/user/praana");
    writeMeta("01OLDER000000000000000001", { cwd, started_at: 1 });
    writeMeta("01NEWER000000000000000002", { cwd, started_at: 2 });
    expect(findLatestSessionForCwd(testLogDir, cwd)).toBe("01NEWER000000000000000002");
  });

  it("prefers last activity over a newer but idle session", () => {
    const cwd = resolve("/home/user/praana");
    // Older start, but events touched more recently → should win.
    writeMeta("01ACTIVE00000000000000001", { cwd, started_at: 1_000 });
    writeEvents("01ACTIVE00000000000000001", 5_000);
    // Newer start, but stale/no recent activity.
    writeMeta("01IDLE0000000000000000002", { cwd, started_at: 2_000 });
    writeEvents("01IDLE0000000000000000002", 2_000);
    expect(findLatestSessionForCwd(testLogDir, cwd)).toBe("01ACTIVE00000000000000001");
  });

  it("matches cwd after path normalization", () => {
    const cwd = resolve("/home/user/praana");
    writeMeta("01SESSION00000000000000003", { cwd });
    expect(findLatestSessionForCwd(testLogDir, cwd + "/")).toBe("01SESSION00000000000000003");
  });

  it("ignores sessions from other directories", () => {
    const target = resolve("/home/user/praana");
    writeMeta("01OTHER000000000000000004", { cwd: resolve("/other") });
    writeMeta("01MATCH000000000000000005", { cwd: target });
    expect(findLatestSessionForCwd(testLogDir, target)).toBe("01MATCH000000000000000005");
  });
});

describe("resolveSessionId", () => {
  beforeEach(() => {
    mkdirSync(testLogDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testLogDir, { recursive: true, force: true });
  });

  it("resolves a full id to itself", () => {
    writeMeta("01FULL0000000000000000001", { cwd: "/home/user/praana" });
    expect(resolveSessionId(testLogDir, "01FULL0000000000000000001")).toBe(
      "01FULL0000000000000000001",
    );
  });

  it("resolves a 12-char prefix to the unique matching session", () => {
    writeMeta("01FULL0000000000000000001", { cwd: "/home/user/praana" });
    writeMeta("02FULL0000000000000000002", { cwd: "/home/user/praana" });
    expect(resolveSessionId(testLogDir, "01FULL000000")).toBe("01FULL0000000000000000001");
  });

  it("throws a session-not-found error when no session matches", () => {
    writeMeta("01FULL0000000000000000001", { cwd: "/home/user/praana" });
    expect(() => resolveSessionId(testLogDir, "ZZNOMATCH0000")).toThrow(/not found/i);
  });

  it("throws an ambiguous-prefix error when multiple sessions match", () => {
    writeMeta("01FULL0000000000000000001", { cwd: "/home/user/praana" });
    writeMeta("01FULL0000000000000000002", { cwd: "/home/user/praana" });
    writeMeta("01FULL0000000000000000003", { cwd: "/home/user/praana" });
    expect(() => resolveSessionId(testLogDir, "01FULL000000")).toThrow(/Ambiguous session prefix/);
  });

  it("throws AmbiguousSessionPrefixError with the matching ids", () => {
    writeMeta("01FULL0000000000000000001", { cwd: "/home/user/praana" });
    writeMeta("01FULL0000000000000000002", { cwd: "/home/user/praana" });
    try {
      resolveSessionId(testLogDir, "01FULL000000");
      expect.unreachable("expected AmbiguousSessionPrefixError");
    } catch (err) {
      expect(err).toBeInstanceOf(AmbiguousSessionPrefixError);
      expect((err as AmbiguousSessionPrefixError).matches).toHaveLength(2);
    }
  });

  it("resolves a lowercase prefix case-insensitively", () => {
    writeMeta("01FULL0000000000000000001", { cwd: "/home/user/praana" });
    expect(resolveSessionId(testLogDir, "01full000000")).toBe("01FULL0000000000000000001");
  });

  it("ignores directories without a valid meta.json", () => {
    mkdirSync(join(testLogDir, "01FULL0000000000000000009"), { recursive: true });
    writeMeta("01FULL0000000000000000001", { cwd: "/home/user/praana" });
    expect(resolveSessionId(testLogDir, "01FULL000000")).toBe("01FULL0000000000000000001");
  });
});
