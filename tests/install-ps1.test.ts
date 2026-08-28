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

const INSTALL_PS1 = resolve("install.ps1");
const POWERSHELL = Bun.which("pwsh") ?? Bun.which("powershell");

function runInstall(
  args: string[],
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  if (!POWERSHELL) {
    throw new Error("PowerShell not found on PATH");
  }
  // Do not use -File: switches after -File are not bound to param() on PS 5.1.
  const result = Bun.spawnSync(
    [POWERSHELL, "-NoProfile", "-ExecutionPolicy", "Bypass", INSTALL_PS1, ...args],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...env,
      },
    },
  );
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout.toString("utf-8"),
    stderr: result.stderr.toString("utf-8"),
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

describe("install.ps1", () => {
  it("documents PowerShell and cmd entry points", () => {
    const source = readFileSync(INSTALL_PS1, "utf-8");
    expect(source).toContain("irm https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1 | iex");
    expect(source).toContain("powershell -NoProfile -ExecutionPolicy Bypass");
    expect(source).toContain("praana-windows-x64.zip");
  });

  it("targets windows-x64 and rejects ARM64", () => {
    if (!POWERSHELL) return;
    const ok = runInstall(["-PrintTarget"], { PRAANA_PROCESSOR_ARCHITECTURE: "AMD64" });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe("praana-windows-x64");

    const arm = runInstall(["-PrintTarget"], { PRAANA_PROCESSOR_ARCHITECTURE: "ARM64" });
    expect(arm.exitCode).not.toBe(0);
    expect(`${arm.stdout}${arm.stderr}`.toLowerCase()).toContain("unsupported");
  }, 30_000);

  it("installs praana.exe and the sidecar into -Prefix from a fixture archive", async () => {
    if (!POWERSHELL) return;
    const root = mkdtempSync(join(tmpdir(), "praana-install-ps1-"));
    const releaseDir = join(root, "release");
    const prefix = join(root, "bin");
    mkdirSync(releaseDir, { recursive: true });

    const staging = join(root, "staging");
    mkdirSync(staging);
    writeFileSync(
      join(staging, "praana.exe"),
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
    chmodSync(join(staging, "praana.exe"), 0o755);
    writeFileSync(join(staging, SIDECAR_ADDON_FILENAME), "fake-native-addon\r\n");
    writeFileSync(join(staging, "praana-natives.json"), '{"apiVersion":"0.3.0"}\n');

    const archiveName = "praana-windows-x64.zip";
    const archivePath = join(releaseDir, archiveName);
    const packed = Bun.spawnSync(
      ["zip", "-j", archivePath, "praana.exe", SIDECAR_ADDON_FILENAME, "praana-natives.json"],
      { cwd: staging, stdout: "pipe", stderr: "pipe" },
    );
    expect(packed.exitCode).toBe(0);

    const hash = await sha256File(archivePath);
    writeFileSync(
      join(releaseDir, "SHA256SUMS"),
      formatSha256Sums([{ filename: archiveName, hash }]),
    );

    try {
      const result = runInstall(["-Prefix", prefix], {
        PRAANA_PROCESSOR_ARCHITECTURE: "AMD64",
        PRAANA_RELEASE_BASE: releaseDir,
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(prefix, "praana.exe"))).toBe(true);
      expect(existsSync(join(prefix, SIDECAR_ADDON_FILENAME))).toBe(true);
      expect(readFileSync(join(prefix, "praana.exe"), "utf-8")).toContain("fixture-praana");
      expect(`${result.stdout}${result.stderr}`).toContain(prefix);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when SHA256SUMS has no entry for the archive", async () => {
    if (!POWERSHELL) return;
    const root = mkdtempSync(join(tmpdir(), "praana-install-ps1-missing-sum-"));
    const releaseDir = join(root, "release");
    mkdirSync(releaseDir);
    writeFileSync(join(releaseDir, "praana-windows-x64.zip"), "not-a-real-archive");
    writeFileSync(
      join(releaseDir, "SHA256SUMS"),
      formatSha256Sums([{ filename: "praana-linux-x64.tar.gz", hash: "abc" }]),
    );

    try {
      const result = runInstall(["-Prefix", join(root, "bin")], {
        PRAANA_PROCESSOR_ARCHITECTURE: "AMD64",
        PRAANA_RELEASE_BASE: releaseDir,
      });
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("SHA256SUMS has no entry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
