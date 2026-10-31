import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  BUN_URL,
  INSTALL_PS1_URL,
  INSTALL_SH_URL,
  findOnPath,
  noticeText,
  run,
  shouldNotify,
  writeNotice,
} from "../scripts/postinstall.js";

const POSTINSTALL_JS = resolve("scripts/postinstall.js");
const NODE = Bun.which("node");

/** File probe that only accepts the exact paths in `present`. */
function fakeProbe(present: string[]): (candidate: string) => boolean {
  return (candidate) => present.includes(candidate);
}

describe("postinstall notice text", () => {
  it("is three lines that name Bun and the POSIX installer on POSIX", () => {
    const lines = noticeText("linux").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("PRAANA runs on Bun (>= 1.4)");
    expect(lines[1]).toContain("If you have not installed Bun yet");
    expect(lines[1]).toContain(BUN_URL);
    expect(lines[2]).toContain(`${INSTALL_SH_URL} | sh`);
    expect(lines[2]).not.toContain("install.ps1");
  });

  it("points Windows at install.ps1 instead of curl | sh", () => {
    const lines = noticeText("win32").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("PRAANA runs on Bun (>= 1.4)");
    expect(lines[1]).toContain("If you have not installed Bun yet");
    expect(lines[1]).toContain(BUN_URL);
    expect(lines[2]).toContain(`irm ${INSTALL_PS1_URL} | iex`);
    expect(lines[2]).not.toContain("install.sh");
    expect(lines[2]).not.toContain("curl");
  });

  it("defaults to the host platform", () => {
    expect(noticeText()).toBe(noticeText(process.platform));
  });
});

describe("package.json postinstall hook", () => {
  it("cannot fail an install, even when node is missing or broken", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { scripts?: Record<string, string> };
    // Works in both sh and cmd: a missing node must not fail `bun install`.
    expect(pkg.scripts?.postinstall).toBe("node scripts/postinstall.js || exit 0");
  });
});

describe("findOnPath", () => {
  it("finds an executable on a POSIX PATH", () => {
    const found = findOnPath("bun", {
      pathValue: "/usr/bin:/home/me/.bun/bin",
      platform: "linux",
      isExecutableFile: fakeProbe(["/home/me/.bun/bin/bun"]),
    });
    expect(found).toBe("/home/me/.bun/bin/bun");
  });

  it("returns null when bun is not on PATH", () => {
    expect(
      findOnPath("bun", {
        pathValue: "/usr/bin:/bin",
        platform: "linux",
        isExecutableFile: fakeProbe(["/usr/bin/node"]),
      }),
    ).toBeNull();
    expect(
      findOnPath("bun", {
        pathValue: "",
        platform: "linux",
        isExecutableFile: () => true,
      }),
    ).toBeNull();
  });

  it("ignores non-executable files and empty PATH entries", () => {
    const seen: string[] = [];
    const found = findOnPath("bun", {
      pathValue: "::/opt/bin:",
      platform: "linux",
      isExecutableFile: (candidate) => {
        seen.push(candidate);
        return false;
      },
    });
    expect(found).toBeNull();
    expect(seen).toEqual(["/opt/bin/bun"]);
  });

  it("probes Windows executable extensions", () => {
    const found = findOnPath("bun", {
      pathValue: "C:\\Users\\me\\.bun\\bin;C:\\Windows",
      platform: "win32",
      pathExt: ".EXE;.CMD",
      isExecutableFile: fakeProbe(["C:\\Users\\me\\.bun\\bin\\bun.exe"]),
    });
    expect(found).toBe("C:\\Users\\me\\.bun\\bin\\bun.exe");
  });
});

describe("shouldNotify", () => {
  it("stays quiet when bun is present", () => {
    expect(shouldNotify({ bunPath: "/home/me/.bun/bin/bun", isDevCheckout: false })).toBe(false);
  });

  it("stays quiet inside a git checkout", () => {
    expect(shouldNotify({ bunPath: null, isDevCheckout: true })).toBe(false);
  });

  it("notifies on a Node-only machine outside a checkout", () => {
    expect(shouldNotify({ bunPath: null, isDevCheckout: false })).toBe(true);
  });

  it("stays quiet when npm runs with --silent", () => {
    expect(
      shouldNotify({ bunPath: null, isDevCheckout: false, silent: true }),
    ).toBe(false);
  });
});

describe("run", () => {
  it("prints the notice when bun is missing and this is not a checkout", () => {
    const result = run({
      env: { PATH: "/usr/bin:/bin" },
      packageRoot: "/pkg",
      exists: () => false,
      find: () => null,
    });
    expect(result.notice).toBe(noticeText());
  });

  it("prints nothing when bun is on PATH", () => {
    const result = run({
      env: { PATH: "/home/me/.bun/bin" },
      packageRoot: "/pkg",
      exists: () => false,
      find: () => "/home/me/.bun/bin/bun",
    });
    expect(result.notice).toBeNull();
  });

  it("uses the Windows installer notice on win32", () => {
    const result = run({
      env: { PATH: "C:\\Windows" },
      platform: "win32",
      packageRoot: "C:\\pkg",
      exists: () => false,
      find: () => null,
    });
    expect(result.notice).toContain("install.ps1");
    expect(result.notice).not.toContain("install.sh");
  });

  it("prints nothing when npm_config_loglevel=silent", () => {
    const result = run({
      env: { PATH: "/usr/bin:/bin", npm_config_loglevel: "silent" },
      packageRoot: "/pkg",
      exists: () => false,
      find: () => null,
    });
    expect(result.notice).toBeNull();
  });

  it("still notifies at the default npm log level", () => {
    const result = run({
      env: { PATH: "/usr/bin:/bin", npm_config_loglevel: "warn" },
      packageRoot: "/pkg",
      exists: () => false,
      find: () => null,
    });
    expect(result.notice).toBe(noticeText());
  });

  it("prints nothing for the repo's own install (.git present)", () => {
    const result = run({
      env: { PATH: "/usr/bin:/bin" },
      packageRoot: "/repo",
      exists: (path: string) => path === "/repo/.git",
      find: () => null,
    });
    expect(result.notice).toBeNull();
    expect(result.isDevCheckout).toBe(true);
  });
});

describe("writeNotice", () => {
  it("writes to the terminal when one is reachable, not to captured stdout", () => {
    const chunks: string[] = [];
    let terminal = "";
    const via = writeNotice(noticeText(), {
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      writeToTerminal: (chunk: string) => {
        terminal += chunk;
        return true;
      },
    });
    expect(via).toBe("terminal");
    expect(terminal).toBe(noticeText());
    expect(chunks).toEqual([]);
  });

  it("uses stdout when the terminal is not wanted (CI)", () => {
    const chunks: string[] = [];
    const via = writeNotice(noticeText(), {
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      useTerminal: false,
      writeToTerminal: () => {
        throw new Error("must not touch the terminal in CI");
      },
    });
    expect(via).toBe("stdout");
    expect(chunks.join("")).toBe(noticeText());
  });

  it("falls back to stdout when there is no terminal", () => {
    const chunks: string[] = [];
    const via = writeNotice(noticeText(), {
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      writeToTerminal: () => false,
    });
    expect(via).toBe("stdout");
    expect(chunks.join("")).toBe(noticeText());
  });
});

describe("postinstall script process", () => {
  it("exits 0 and stays silent when bun is on PATH", () => {
    if (!NODE) return;
    const root = mkdtempSync(join(tmpdir(), "praana-postinstall-"));
    try {
      mkdirSync(join(root, "scripts"));
      copyFileSync(POSTINSTALL_JS, join(root, "scripts", "postinstall.js"));
      const bunDir = join(root, "bun-bin");
      mkdirSync(bunDir);
      // Stand-in for bun: the lookup only checks that the file exists and is +x.
      copyFileSync(NODE, join(bunDir, "bun"));
      Bun.spawnSync(["chmod", "+x", join(bunDir, "bun")]);
      const result = Bun.spawnSync([NODE, join(root, "scripts", "postinstall.js")], {
        env: { ...process.env, CI: "1", PATH: `${bunDir}:/usr/bin:/bin` },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString("utf-8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("stays silent when npm runs with --silent", () => {
    if (!NODE) return;
    const root = mkdtempSync(join(tmpdir(), "praana-postinstall-silent-"));
    try {
      mkdirSync(join(root, "scripts"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
      copyFileSync(POSTINSTALL_JS, join(root, "scripts", "postinstall.js"));
      const result = Bun.spawnSync([NODE, join(root, "scripts", "postinstall.js")], {
        env: {
          ...process.env,
          CI: "1",
          PATH: "/nonexistent-dir",
          npm_config_loglevel: "silent",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString("utf-8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("prints the notice when the package dir is reached through a symlink", () => {
    if (!NODE) return;
    const root = mkdtempSync(join(tmpdir(), "praana-postinstall-symlink-"));
    try {
      const real = join(root, "real");
      mkdirSync(join(real, "scripts"), { recursive: true });
      writeFileSync(join(real, "package.json"), JSON.stringify({ type: "module" }));
      copyFileSync(POSTINSTALL_JS, join(real, "scripts", "postinstall.js"));
      const link = join(root, "link");
      symlinkSync(real, link, "dir");
      // argv[1] is the symlinked path; import.meta.url is the realpath, so a
      // plain resolve() comparison silently decides "not the entry point".
      const result = Bun.spawnSync([NODE, join(link, "scripts", "postinstall.js")], {
        env: { ...process.env, CI: "1", PATH: "/nonexistent-dir" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString("utf-8")).toBe(noticeText());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("prints the notice and exits 0 on a Node-only machine", () => {
    if (!NODE) return;
    const root = mkdtempSync(join(tmpdir(), "praana-postinstall-nodeonly-"));
    try {
      mkdirSync(join(root, "scripts"));
      copyFileSync(POSTINSTALL_JS, join(root, "scripts", "postinstall.js"));
      const result = Bun.spawnSync([NODE, join(root, "scripts", "postinstall.js")], {
        env: { ...process.env, CI: "1", PATH: "/nonexistent-dir" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString("utf-8")).toBe(noticeText());
      expect(result.stderr.toString("utf-8")).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
