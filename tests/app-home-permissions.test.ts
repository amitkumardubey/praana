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
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appHomePath,
  ensureAppHome,
  resolveDefaultAppLogDir,
  resolveDefaultSessionLogDir,
  tightenAppHomePermissions,
} from "../src/app-identity.js";
import { setEmbedderConsent } from "../src/memory/embedder-consent.js";
import { writeProviderConfig } from "../src/setup/config-writer.js";
import { EventLog, ensureSessionDir, writeSessionMeta } from "../src/event-log.js";
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

  it.skipIf(isWindows)("removes other access from an existing permissive session directory on open", () => {
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
      expect(modeOf(sessionDir)).toBe(0o750);
      expect(modeOf(join(sessionDir, "events.jsonl"))).toBe(0o600);
    } finally {
      eventLog.close();
    }
  });

  it.skipIf(isWindows)("ensureSessionDir only chmods a directory that is open to others", () => {
    const dir = join(resolveDefaultSessionLogDir(), `perm-test-ensure-${process.pid}-${Date.now()}`);
    created.push(resolveDefaultSessionLogDir());
    const chmodded: Array<[string, number]> = [];
    const chmod = (path: string, mode: number) => {
      chmodded.push([path, mode]);
    };

    ensureSessionDir(dir, { chmod });
    expect(modeOf(dir)).toBe(0o700);
    expect(chmodded).toEqual([]);

    chmodSync(dir, 0o2775);
    ensureSessionDir(dir, { chmod });
    expect(chmodded).toEqual([[dir, 0o2770]]);
  });

  it.skipIf(isWindows)("ensureSessionDir reports a chmod failure and does not throw", () => {
    const dir = join(resolveDefaultSessionLogDir(), `perm-test-fail-${process.pid}-${Date.now()}`);
    created.push(resolveDefaultSessionLogDir());
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
    const reported: string[] = [];

    expect(() =>
      ensureSessionDir(dir, {
        chmod: () => {
          throw new Error("EPERM");
        },
        onError: (path) => reported.push(path),
      }),
    ).not.toThrow();
    expect(reported).toEqual([dir]);

    // The default reporter (debug log) must not throw either.
    expect(() =>
      ensureSessionDir(dir, {
        chmod: () => {
          throw new Error("EPERM");
        },
      }),
    ).not.toThrow();
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

  it.skipIf(isWindows)("removes other access from an existing 0755 app home, sessions root and logs dir", () => {
    const { home, sessions } = makeHome(0o755, 0o755);
    const logs = resolveDefaultAppLogDir();
    mkdirSync(logs, { recursive: true });
    chmodSync(logs, 0o755);

    tightenAppHomePermissions();

    // Only the "other" bits go; group bits are kept (see group-shared test).
    expect(modeOf(home)).toBe(0o750);
    expect(modeOf(sessions)).toBe(0o750);
    expect(modeOf(logs)).toBe(0o750);
  });

  it.skipIf(isWindows)("keeps group access and the setgid bit of a group-shared home", () => {
    const { home, sessions } = makeHome(0o2775, 0o2775);

    tightenAppHomePermissions();

    expect(statSync(home).mode & 0o7777).toBe(0o2770);
    expect(statSync(sessions).mode & 0o7777).toBe(0o2770);
  });

  it.skipIf(isWindows)("does not chmod through a symlinked app home", () => {
    root = mkdtempSync(join(tmpdir(), "praana-perms-test-"));
    process.env.PRAANA_HOME = root;
    const target = join(root, "elsewhere");
    mkdirSync(join(target, "sessions"), { recursive: true });
    chmodSync(target, 0o755);
    chmodSync(join(target, "sessions"), 0o755);
    symlinkSync(target, appHomePath());

    tightenAppHomePermissions();

    expect(modeOf(target)).toBe(0o755);
    expect(modeOf(join(target, "sessions"))).toBe(0o755);
  });

  it.skipIf(isWindows)("skips a symlinked sessions directory", () => {
    const { home } = makeHome(0o755, null);
    const target = join(root!, "elsewhere");
    mkdirSync(target, { recursive: true });
    chmodSync(target, 0o755);
    symlinkSync(target, resolveDefaultSessionLogDir());

    tightenAppHomePermissions();

    expect(modeOf(home)).toBe(0o750);
    expect(modeOf(target)).toBe(0o755);
  });

  it.skipIf(isWindows)("skips a directory owned by another user", () => {
    const { home } = makeHome(0o755, 0o755);
    const chmodded: string[] = [];
    const realUid = process.getuid!();

    tightenAppHomePermissions({
      getuid: () => realUid + 1,
      chmod: (path) => chmodded.push(path),
    });

    expect(chmodded).toEqual([]);
    expect(modeOf(home)).toBe(0o755);
  });

  it.skipIf(isWindows)("skips a directory whose injected stat reports another owner", () => {
    makeHome(0o755, null);
    const chmodded: string[] = [];

    tightenAppHomePermissions({
      getuid: () => 1000,
      lstat: () => ({ mode: 0o40755, uid: 4242, isSymbolicLink: () => false }),
      chmod: (path) => chmodded.push(path),
    });

    expect(chmodded).toEqual([]);
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

  it.skipIf(isWindows)("reports a failed chmod through onError for each directory", () => {
    const { home, sessions } = makeHome(0o755, 0o755);
    const reported: Array<{ path: string; message: string }> = [];

    tightenAppHomePermissions({
      chmod: () => {
        throw new Error("EPERM: operation not permitted");
      },
      onError: (path, err) =>
        reported.push({ path, message: (err as Error).message }),
    });

    expect(reported.map((r) => r.path)).toEqual([home, sessions]);
    expect(reported[0]!.message).toContain("EPERM");
  });

  it.skipIf(isWindows)("survives an onError callback that throws", () => {
    makeHome(0o755, 0o755);

    expect(() =>
      tightenAppHomePermissions({
        chmod: () => {
          throw new Error("EPERM");
        },
        onError: () => {
          throw new Error("logger not ready");
        },
      }),
    ).not.toThrow();
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

describe("startup fix-up call order", () => {
  it("runs before every early-exit CLI branch in main()", () => {
    const src = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf-8");
    const body = src.slice(src.indexOf("export async function main()"));
    const fixUp = body.indexOf("tightenAppHomePermissions(");
    expect(fixUp).toBeGreaterThan(-1);
    for (const branch of [
      "parsed.showHelp",
      "parsed.versionMode",
      "parsed.providersMode",
      "parsed.modelsMode",
      "parsed.setupMode",
      "parsed.doctorMode",
      "parsed.upgradeMode",
    ]) {
      const at = body.indexOf(branch);
      expect(at).toBeGreaterThan(-1);
      expect(fixUp).toBeLessThan(at);
    }
    // Called once, not again after the early branches.
    expect(body.split("tightenAppHomePermissions(").length - 1).toBe(1);
  });
});

describe("app-identity module graph", () => {
  it("does not import the logger (no import cycle)", () => {
    const src = readFileSync(join(import.meta.dir, "../src/app-identity.ts"), "utf-8");
    const specifiers = [...src.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    expect(specifiers.length).toBeGreaterThan(0);
    // Only node: builtins: nothing in src/ can import back into a cycle.
    for (const spec of specifiers) {
      expect(spec.startsWith("node:")).toBe(true);
    }
    expect(src).not.toContain("logger.js");
  });
});
