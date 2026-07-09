import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findLatestSessionForCwd } from "../src/event-log.js";
import type { SessionMeta } from "../src/types.js";

const testLogDir = join(tmpdir(), "praana-test-session-resolver");

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
