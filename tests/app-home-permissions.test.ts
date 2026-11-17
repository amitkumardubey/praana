/**
 * App home and session log permissions (issue #804).
 *
 * Session transcripts and compiled prompts used to land with the default umask
 * (`0755` directories, `0644` files), so any local user on a shared machine
 * could read them. These tests pin the owner-only modes PRAANA creates and the
 * startup fix-up that tightens directories created before the change.
 *
 * All paths come from the isolated `PRAANA_HOME` set by
 * `tests/helpers/isolated-home.ts`; the real home is never touched.
 */
import { describe, it, expect, afterEach } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appHomePath,
  ensureAppHome,
  resolveDefaultSessionLogDir,
  tightenAppHomePermissions,
} from "../src/app-identity.js";
import { setEmbedderConsent } from "../src/memory/embedder-consent.js";
import { writeProviderConfig } from "../src/setup/config-writer.js";
import { EventLog, writeSessionMeta } from "../src/event-log.js";
import { isWindows } from "./helpers/platform.js";

/** Permission bits (lowest 9) of a path. */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("ensureAppHome", () => {
  const originalPraanaHome = process.env.PRAANA_HOME;
  let root: string | null = null;

  /** Fresh isolated PRAANA_HOME root whose app home does not exist yet. */
  function freshRoot(): void {
    root = mkdtempSync(join(tmpdir(), "praana-perms-test-"));
    process.env.PRAANA_HOME = root;
  }

  afterEach(() => {
    if (originalPraanaHome !== undefined) {
      process.env.PRAANA_HOME = originalPraanaHome;
    } else {
      delete process.env.PRAANA_HOME;
    }
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = null;
    }
  });

  it.skipIf(isWindows)("creates the app home and nested directories 0700", () => {
    freshRoot();

    const dir = ensureAppHome("a", "b");

    expect(dir).toBe(appHomePath("a", "b"));
    expect(modeOf(appHomePath())).toBe(0o700);
    expect(modeOf(appHomePath("a"))).toBe(0o700);
    expect(modeOf(dir)).toBe(0o700);
  });

  it.skipIf(isWindows)("creates only the app home when called without parts", () => {
    freshRoot();

    expect(ensureAppHome()).toBe(appHomePath());
    expect(modeOf(appHomePath())).toBe(0o700);
  });

  it.skipIf(isWindows)("is private even under a permissive umask", () => {
    freshRoot();
    const previous = process.umask(0o000);
    try {
      ensureAppHome("models");
    } finally {
      process.umask(previous);
    }

    expect(modeOf(appHomePath())).toBe(0o700);
    expect(modeOf(appHomePath("models"))).toBe(0o700);
  });

  it.skipIf(isWindows)("leaves an existing directory's mode alone", () => {
    freshRoot();
    mkdirSync(appHomePath(), { recursive: true });
    chmodSync(appHomePath(), 0o755);

    ensureAppHome();

    expect(modeOf(appHomePath())).toBe(0o755);
  });

  it.skipIf(isWindows)("is used by writers that create the app home", () => {
    freshRoot();
    setEmbedderConsent("skip");
    expect(modeOf(appHomePath())).toBe(0o700);

    rmSync(appHomePath(), { recursive: true, force: true });
    const result = writeProviderConfig("openrouter", { model: "x/y" });
    expect(result.written).toBe(true);
    expect(modeOf(appHomePath())).toBe(0o700);
  });
});

describe("session directory and file modes", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const path of created.splice(0)) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindows)("creates a new session directory 0700 and its files 0600", () => {
    const logDir = resolveDefaultSessionLogDir();
    created.push(logDir);

    const sessionId = `perm-test-${process.pid}-${Date.now()}`;
    const sessionDir = join(logDir, sessionId);
    created.push(sessionDir);

    const eventLog = new EventLog(sessionId, logDir);
    try {
      eventLog.append({
        kind: "user_message",
        actor: "user",
        payload: { text: "secret transcript" },
      });
      writeSessionMeta(logDir, {
        session_id: sessionId,
        started_at: Date.now(),
        cwd: "/tmp/workspace",
        agent: "praana",
      });

      expect(modeOf(sessionDir)).toBe(0o700);
      expect(modeOf(join(sessionDir, "events.jsonl"))).toBe(0o600);
      expect(modeOf(join(sessionDir, "meta.json"))).toBe(0o600);
      expect(existsSync(join(sessionDir, "events.jsonl"))).toBe(true);
      expect(readFileSync(join(sessionDir, "meta.json"), "utf-8")).toContain(sessionId);
    } finally {
      eventLog.close();
    }
  });

  it.skipIf(isWindows)("tightens an existing permissive session directory on open", () => {
    const logDir = resolveDefaultSessionLogDir();
    created.push(logDir);

    const sessionId = `perm-test-tighten-${process.pid}-${Date.now()}`;
    const sessionDir = join(logDir, sessionId);
    created.push(sessionDir);
    mkdirSync(sessionDir, { recursive: true, mode: 0o755 });
    chmodSync(sessionDir, 0o755);
    expect(modeOf(sessionDir)).toBe(0o755);

    const eventLog = new EventLog(sessionId, logDir);
    try {
      expect(modeOf(sessionDir)).toBe(0o700);
      expect(modeOf(join(sessionDir, "events.jsonl"))).toBe(0o600);
    } finally {
      eventLog.close();
    }
  });
});

describe("tightenAppHomePermissions", () => {
  const originalPraanaHome = process.env.PRAANA_HOME;
  let root: string | null = null;

  afterEach(() => {
    if (originalPraanaHome !== undefined) {
      process.env.PRAANA_HOME = originalPraanaHome;
    } else {
      delete process.env.PRAANA_HOME;
    }
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = null;
    }
  });

  /** Isolated PRAANA_HOME root with an app home and a sessions root. */
  function makeHome(appHomeMode: number, sessionsMode: number | null): {
    home: string;
    sessions: string;
  } {
    root = mkdtempSync(join(tmpdir(), "praana-perms-test-"));
    process.env.PRAANA_HOME = root;
    const home = appHomePath();
    mkdirSync(home, { recursive: true, mode: 0o700 });
    chmodSync(home, appHomeMode);
    const sessions = resolveDefaultSessionLogDir();
    if (sessionsMode !== null) {
      mkdirSync(sessions, { recursive: true, mode: 0o700 });
      chmodSync(sessions, sessionsMode);
    }
    return { home, sessions };
  }

  it.skipIf(isWindows)("tightens an existing 0755 app home and sessions root to 0700", () => {
    const { home, sessions } = makeHome(0o755, 0o755);

    tightenAppHomePermissions();

    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(sessions)).toBe(0o700);
  });

  it.skipIf(isWindows)("leaves an already 0700 app home unchanged", () => {
    const { home, sessions } = makeHome(0o700, 0o700);

    tightenAppHomePermissions();

    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(sessions)).toBe(0o700);
  });

  it.skipIf(isWindows)("does nothing when the app home does not exist", () => {
    root = mkdtempSync(join(tmpdir(), "praana-perms-test-"));
    process.env.PRAANA_HOME = root;

    expect(() => tightenAppHomePermissions()).not.toThrow();
    expect(existsSync(appHomePath())).toBe(false);
  });

  it.skipIf(isWindows)("swallows a chmod failure", () => {
    const { home } = makeHome(0o755, 0o755);

    expect(() =>
      tightenAppHomePermissions({
        chmod: () => {
          throw new Error("EPERM: operation not permitted");
        },
      }),
    ).not.toThrow();
    // The failure is best effort: the directory keeps its old mode.
    expect(modeOf(home)).toBe(0o755);
  });
});
