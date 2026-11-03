import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import { formatSha256Sums } from "../scripts/package-release-binaries.js";
import { isWindows } from "./helpers/platform.js";
import { SIDECAR_ADDON_FILENAME } from "../src/native/sidecar.js";

const INSTALL_SH = resolve("install.sh");
const INSTALL_PS1 = resolve("install.ps1");

function runInstall(
  args: string[],
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["sh", INSTALL_SH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
    },
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString("utf-8"),
    stderr: result.stderr.toString("utf-8"),
  };
}

function printTarget(unameS: string, unameM: string, extra: Record<string, string> = {}) {
  return runInstall(["--print-target"], {
    PRAANA_UNAME_S: unameS,
    PRAANA_UNAME_M: unameM,
    ...extra,
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

// POSIX-only: runs install.sh under `sh`, which is not present on Windows.
describe.skipIf(isWindows)("install.sh --print-target", () => {
  it("maps linux-x64, linux-arm64, darwin-arm64, and darwin-x64", () => {
    const cases: Array<[string, string, string, Record<string, string>]> = [
      ["Linux", "x86_64", "praana-linux-x64", { PRAANA_LIBC: "gnu" }],
      ["Linux", "amd64", "praana-linux-x64", { PRAANA_LIBC: "gnu" }],
      ["Linux", "aarch64", "praana-linux-arm64", { PRAANA_LIBC: "gnu" }],
      ["Linux", "arm64", "praana-linux-arm64", { PRAANA_LIBC: "gnu" }],
      ["Darwin", "arm64", "praana-darwin-arm64", {}],
      ["Darwin", "aarch64", "praana-darwin-arm64", {}],
      ["Darwin", "x86_64", "praana-darwin-x64", {}],
    ];
    for (const [os, machine, stem, extra] of cases) {
      const result = printTarget(os, machine, extra);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(stem);
    }
  });

  it("rejects musl, 32-bit, Windows, and unknown OS without downloading", () => {
    const cases: Array<[string, string, Record<string, string>]> = [
      ["Linux", "x86_64", { PRAANA_LIBC: "musl" }],
      ["Linux", "i686", { PRAANA_LIBC: "gnu" }],
      ["MINGW64_NT-10.0", "x86_64", {}],
      ["MSYS_NT-10.0", "x86_64", {}],
      ["FreeBSD", "x86_64", {}],
    ];
    for (const [os, machine, extra] of cases) {
      const result = printTarget(os, machine, extra);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain("unsupported");
    }
  });
});

/**
 * The capability regexes the installers grep out of `praana doctor`. Extracted
 * from the scripts themselves so this test tracks the shipped check, not a copy.
 */
function installerSelfCheckPatterns(): RegExp[] {
  const sh = [...readFileSync(INSTALL_SH, "utf-8").matchAll(/grep -E '([^']+)'/g)].map(
    (m) => m[1]!,
  );
  const ps1 = [
    ...readFileSync(INSTALL_PS1, "utf-8").matchAll(/-notmatch "([^"]+)"/g),
  ].map((m) => m[1]!);
  expect(sh).toHaveLength(2);
  expect(ps1).toHaveLength(2);
  // POSIX bracket class -> JS regex.
  return [...sh, ...ps1].map((p) => new RegExp(p.replaceAll("[[:space:]]", "\\s")));
}

describe("installer self-check vs real doctor output", () => {
  it("matches the doctor lines for a healthy native build", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const home = mkdtempSync(join(tmpdir(), "praana-doctor-regex-"));
    try {
      // Run doctor's real formatting in a child process so the addon stub is
      // confined there; stubbing in-process would leak into other test files.
      const script = `
        import { mock } from "bun:test";
        mock.module("./src/native/index.js", () => ({
          loadNative: async () => ({ ok: true, bindings: { ping: () => "pong" } }),
          formatNativeStatus: () => ({ kind: "available", version: "0.16.0" }),
          tryGetNative: async () => ({
            grep: () => ({ ok: true, matches: [{ path: "probe.txt", line: 1 }] }),
          }),
        }));
        const { handleDoctor } = await import("./src/doctor.js");
        const { lines } = await handleDoctor({
          llm: { provider: "ollama", model: "llama3" },
          memory: { enabled: false },
          compiler: { token_budget: 100000 },
          tiers: {},
          session: { log_dir: process.env.PRAANA_HOME },
          consolidation: {},
          shell: {},
          edit: { confirm: false },
          skills: { enabled: false },
          ui: {},
          context_engine: { enabled: false },
          project_detection: { enabled: false },
          turn: { max_steps: 25 },
        });
        console.log(lines.join("\\n"));
      `;
      const child = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: repoRoot,
        env: { ...process.env, PRAANA_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = child.stdout.toString("utf-8");
      expect(child.stderr.toString("utf-8")).toBe("");
      expect(child.exitCode).toBe(0);
      // Reword any doctor capability line and one of these patterns stops matching.
      for (const pattern of installerSelfCheckPatterns()) {
        expect(output).toMatch(pattern);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

// POSIX-only: builds a temp PATH from symlinks and launches /bin/sh.
describe.skipIf(isWindows)("install.sh missing-command hints", () => {
  /** Temp PATH containing only symlinks to `names` (absolute /bin/sh launch). */
  function binWith(names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "praana-install-path-"));
    for (const name of names) {
      const found = Bun.which(name);
      if (!found) throw new Error(`test host is missing ${name}`);
      symlinkSync(found, join(dir, name));
    }
    return dir;
  }

  function runWithPath(pathValue: string) {
    const result = Bun.spawnSync(["/bin/sh", INSTALL_SH], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PATH: pathValue,
        PRAANA_UNAME_S: "Linux",
        PRAANA_UNAME_M: "x86_64",
        PRAANA_LIBC: "gnu",
      },
    });
    return {
      exitCode: result.exitCode ?? 1,
      output: `${result.stdout.toString("utf-8")}${result.stderr.toString("utf-8")}`,
    };
  }

  it("offers the apt hint for curl, including ca-certificates", () => {
    const dir = binWith(["tar", "awk", "grep"]);
    try {
      const result = runWithPath(dir);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("requires 'curl'");
      expect(result.output).toContain("apt-get install -y curl ca-certificates");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("offers the apt hint for tar", () => {
    const dir = binWith(["curl", "awk", "grep"]);
    try {
      const result = runWithPath(dir);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("requires 'tar'");
      expect(result.output).toContain("apt-get install -y tar");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses a generic hint for POSIX tools instead of the wrong apt package", () => {
    // need_cmd covers curl, tar, awk and grep; the rest of the POSIX tools are
    // used later, so only these two take the generic branch.
    for (const missing of ["awk", "grep"]) {
      const dir = binWith(
        ["curl", "tar", "awk", "grep"].filter((name) => name !== missing),
      );
      try {
        const result = runWithPath(dir);
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain(`requires '${missing}'`);
        expect(result.output).toContain(
          `install '${missing}' with your package manager`,
        );
        expect(result.output).not.toContain(`apt-get install -y ${missing}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("install.sh POSIX", () => {
  it("has no bashisms ([[, source, arrays)", () => {
    const source = readFileSync(INSTALL_SH, "utf-8");
    const body = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    // `[[:space:]]` is a POSIX bracket class, not the bash `[[` keyword.
    expect(body).not.toMatch(/\[\[(?!:)/);
    expect(body).not.toMatch(/\bsource\b/);
    expect(body).not.toMatch(/\bdeclare\b/);
    expect(body).not.toMatch(/\w+=\(/);
  });

  it("checks doctor capabilities without depending on the ✓ glyph", () => {
    const source = readFileSync(INSTALL_SH, "utf-8");
    expect(source).not.toContain("grep '✓");
    expect(source).toContain("native:[[:space:]]+available");
    expect(source).toContain("search:[[:space:]]+native grep available");
  });
});

function fileReleaseBase(dir: string): string {
  return `file://${dir}`;
}

/** Fake `praana` binary: `doctor` prints $doctorBody, records PRAANA_HOME. */
function fixturePraana(doctorBody: string): string {
  return `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "PRAANA v0.0.0-fixture"
  exit 0
fi
if [ "$1" = "doctor" ]; then
  if [ -n "\${PRAANA_TEST_RECORD:-}" ]; then
    printf '%s\\n' "\${PRAANA_HOME:-unset}" > "$PRAANA_TEST_RECORD"
  fi
  home="\${PRAANA_HOME:-$HOME/.praana}"
  mkdir -p "$home" 2>/dev/null || true
  : > "$home/doctor-ran"
${doctorBody}
  exit 0
fi
echo fixture-praana
`;
}

async function buildRelease(root: string, praanaSource: string) {
  const releaseDir = join(root, "release");
  const prefix = join(root, "bin");
  mkdirSync(releaseDir, { recursive: true });

  const staging = join(root, "staging");
  mkdirSync(staging);
  writeFileSync(join(staging, "praana"), praanaSource);
  chmodSync(join(staging, "praana"), 0o755);
  writeFileSync(join(staging, SIDECAR_ADDON_FILENAME), "fake-native-addon\n");

  const archiveName = "praana-linux-x64.tar.gz";
  const archivePath = join(releaseDir, archiveName);
  const packed = Bun.spawnSync(["tar", "-czf", archivePath, "praana", SIDECAR_ADDON_FILENAME], {
    cwd: staging,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packed.exitCode).toBe(0);

  const hash = await sha256File(archivePath);
  writeFileSync(
    join(releaseDir, "SHA256SUMS"),
    formatSha256Sums([{ filename: archiveName, hash }]),
  );
  return { releaseDir, prefix };
}

// POSIX-only: runs install.sh under `sh` and packs fixtures with `tar`.
describe.skipIf(isWindows)("install.sh checksum install", () => {
  it("installs praana and the sidecar into --prefix from a fixture archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-install-sh-"));
    const releaseDir = join(root, "release");
    const prefix = join(root, "bin");
    mkdirSync(releaseDir, { recursive: true });

    const staging = join(root, "staging");
    mkdirSync(staging);
    writeFileSync(
      join(staging, "praana"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "PRAANA v0.0.0-fixture"
  exit 0
fi
if [ "$1" = "doctor" ]; then
  echo "✓ native: available (0.3.0, ping ok)"
  echo "✓ search: native grep available (search_code, find_files)"
  echo "⚠ embedder: runtime ready, weights not downloaded"
  echo "All checks passed."
  exit 0
fi
echo fixture-praana
`,
    );
    chmodSync(join(staging, "praana"), 0o755);
    writeFileSync(join(staging, SIDECAR_ADDON_FILENAME), "fake-native-addon\n");
    writeFileSync(join(staging, "praana-natives.json"), '{"apiVersion":"0.3.0"}\n');

    const archiveName = "praana-linux-x64.tar.gz";
    const archivePath = join(releaseDir, archiveName);
    const packed = Bun.spawnSync(
      ["tar", "-czf", archivePath, "praana", SIDECAR_ADDON_FILENAME, "praana-natives.json"],
      { cwd: staging, stdout: "pipe", stderr: "pipe" },
    );
    expect(packed.exitCode).toBe(0);

    const hash = await sha256File(archivePath);
    writeFileSync(
      join(releaseDir, "SHA256SUMS"),
      formatSha256Sums([{ filename: archiveName, hash }]),
    );

    try {
      const result = runInstall(["--prefix", prefix], {
        PRAANA_UNAME_S: "Linux",
        PRAANA_UNAME_M: "x86_64",
        PRAANA_LIBC: "gnu",
        PRAANA_RELEASE_BASE: fileReleaseBase(releaseDir),
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(prefix, "praana"))).toBe(true);
      expect(existsSync(join(prefix, SIDECAR_ADDON_FILENAME))).toBe(true);
      expect(readFileSync(join(prefix, "praana"), "utf-8")).toContain("fixture-praana");
      expect(readFileSync(join(prefix, SIDECAR_ADDON_FILENAME), "utf-8")).toContain(
        "fake-native-addon",
      );
      expect(`${result.stdout}${result.stderr}`).toContain(prefix);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fail install when doctor still uses the pre-0.15 search line", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-install-sh-old-doctor-"));
    const releaseDir = join(root, "release");
    const prefix = join(root, "bin");
    mkdirSync(releaseDir, { recursive: true });

    const staging = join(root, "staging");
    mkdirSync(staging);
    writeFileSync(
      join(staging, "praana"),
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "PRAANA 0.14.0"
  exit 0
fi
if [ "$1" = "doctor" ]; then
  echo "✓ native: available (0.2.0)"
  echo "⚠ search: fff unavailable: unknown"
  echo "All checks passed."
  exit 0
fi
echo fixture-praana
`,
    );
    chmodSync(join(staging, "praana"), 0o755);
    writeFileSync(join(staging, SIDECAR_ADDON_FILENAME), "fake-native-addon\n");

    const archiveName = "praana-linux-x64.tar.gz";
    const archivePath = join(releaseDir, archiveName);
    const packed = Bun.spawnSync(
      ["tar", "-czf", archivePath, "praana", SIDECAR_ADDON_FILENAME],
      { cwd: staging, stdout: "pipe", stderr: "pipe" },
    );
    expect(packed.exitCode).toBe(0);

    const hash = await sha256File(archivePath);
    writeFileSync(
      join(releaseDir, "SHA256SUMS"),
      formatSha256Sums([{ filename: archiveName, hash }]),
    );

    try {
      const result = runInstall(["--prefix", prefix], {
        PRAANA_UNAME_S: "Linux",
        PRAANA_UNAME_M: "x86_64",
        PRAANA_LIBC: "gnu",
        PRAANA_RELEASE_BASE: fileReleaseBase(releaseDir),
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(prefix, "praana"))).toBe(true);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "doctor did not report search capability",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when SHA256SUMS has no entry for the archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-install-missing-sum-"));
    const releaseDir = join(root, "release");
    mkdirSync(releaseDir);
    writeFileSync(join(releaseDir, "praana-linux-x64.tar.gz"), "not-a-real-archive");
    writeFileSync(
      join(releaseDir, "SHA256SUMS"),
      formatSha256Sums([{ filename: "praana-darwin-arm64.tar.gz", hash: "abc" }]),
    );

    try {
      const result = runInstall(["--prefix", join(root, "bin")], {
        PRAANA_UNAME_S: "Linux",
        PRAANA_UNAME_M: "x86_64",
        PRAANA_LIBC: "gnu",
        PRAANA_RELEASE_BASE: fileReleaseBase(releaseDir),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("SHA256SUMS has no entry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails clearly when the latest release has no archive", () => {
    const root = mkdtempSync(join(tmpdir(), "praana-empty-release-"));
    try {
      const result = runInstall(["--prefix", join(root, "bin")], {
        PRAANA_UNAME_S: "Linux",
        PRAANA_UNAME_M: "x86_64",
        PRAANA_LIBC: "gnu",
        PRAANA_RELEASE_BASE: fileReleaseBase(root),
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toLowerCase()).toContain("no archive on latest release");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not warn when the console mangles the check mark", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-install-sh-mangled-"));
    try {
      const { releaseDir, prefix } = await buildRelease(
        root,
        fixturePraana(
          [
            '  echo "Γ£ô native: available (0.3.0, ping ok)"',
            '  echo "Γ£ô search: native grep available (search_code, find_files)"',
            '  echo "All checks passed."',
          ].join("\n"),
        ),
      );
      const result = runInstall(["--prefix", prefix], {
        PRAANA_UNAME_S: "Linux",
        PRAANA_UNAME_M: "x86_64",
        PRAANA_LIBC: "gnu",
        PRAANA_RELEASE_BASE: fileReleaseBase(releaseDir),
      });
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain("warning: doctor did not report");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still warns when doctor does not report the native capability", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-install-sh-no-native-"));
    try {
      const { releaseDir, prefix } = await buildRelease(
        root,
        fixturePraana(
          [
            '  echo "✓ search: native grep available (search_code, find_files)"',
            '  echo "⚠ native: unavailable: sidecar missing"',
          ].join("\n"),
        ),
      );
      const result = runInstall(["--prefix", prefix], {
        PRAANA_UNAME_S: "Linux",
        PRAANA_UNAME_M: "x86_64",
        PRAANA_LIBC: "gnu",
        PRAANA_RELEASE_BASE: fileReleaseBase(releaseDir),
      });
      expect(result.exitCode).toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "doctor did not report native capability",
      );
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "doctor did not report search capability",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the doctor self-check with an isolated PRAANA_HOME", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-install-sh-home-"));
    const fakeHome = join(root, "home");
    const record = join(root, "doctor-home.txt");
    mkdirSync(fakeHome, { recursive: true });
    try {
      const { releaseDir, prefix } = await buildRelease(
        root,
        fixturePraana(
          [
            '  echo "✓ native: available (0.3.0, ping ok)"',
            '  echo "✓ search: native grep available (search_code, find_files)"',
          ].join("\n"),
        ),
      );
      const result = runInstall(["--prefix", prefix], {
        HOME: fakeHome,
        PRAANA_TEST_RECORD: record,
        PRAANA_UNAME_S: "Linux",
        PRAANA_UNAME_M: "x86_64",
        PRAANA_LIBC: "gnu",
        PRAANA_RELEASE_BASE: fileReleaseBase(releaseDir),
      });
      expect(result.exitCode).toBe(0);

      // doctor ran with a PRAANA_HOME of its own, not the user's real home…
      const doctorHome = readFileSync(record, "utf-8").trim();
      expect(doctorHome).not.toBe("unset");
      expect(doctorHome.startsWith(fakeHome)).toBe(false);
      expect(doctorHome.endsWith("selfcheck-home")).toBe(true);
      // …and that directory is deleted again before the installer exits.
      expect(existsSync(doctorHome)).toBe(false);
      // The real home was never touched.
      expect(existsSync(join(fakeHome, ".praana"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
