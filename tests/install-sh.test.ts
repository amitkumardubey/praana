import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";
import { formatSha256Sums } from "../scripts/package-release-binaries.js";
import { SIDECAR_ADDON_FILENAME } from "../src/native/sidecar.js";

const INSTALL_SH = resolve("install.sh");

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

describe("install.sh --print-target", () => {
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

describe("install.sh POSIX", () => {
  it("has no bashisms ([[, source, arrays)", () => {
    const source = readFileSync(INSTALL_SH, "utf-8");
    const body = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(body).not.toContain("[[");
    expect(body).not.toMatch(/\bsource\b/);
    expect(body).not.toMatch(/\bdeclare\b/);
    expect(body).not.toMatch(/\w+=\(/);
  });
});

function fileReleaseBase(dir: string): string {
  return `file://${dir}`;
}

describe("install.sh checksum install", () => {
  it("installs praana and the sidecar into --prefix from a fixture archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "praana-install-sh-"));
    const releaseDir = join(root, "release");
    const prefix = join(root, "bin");
    mkdirSync(releaseDir, { recursive: true });

    const staging = join(root, "staging");
    mkdirSync(staging);
    writeFileSync(join(staging, "praana"), "#!/bin/sh\necho fixture-praana\n");
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
});
