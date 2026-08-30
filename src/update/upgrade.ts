import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { classifyInstallKind, type InstallKind } from "./install-kind.js";
import { isNewer } from "./semver.js";
import { APP_VERSION } from "../app-banner.js";

export const INSTALL_SH_URL =
  "https://raw.githubusercontent.com/amitkumardubey/praana/main/install.sh";
export const INSTALL_PS1_URL =
  "https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1";

export interface InstallerArgs {
  prefix: string;
  platform: string;
  command: string;
}

export interface UpgradeResult {
  lines: string[];
  exitCode: number;
  ranInstaller: boolean;
  prefix?: string;
}

export interface RunUpgradeOptions {
  force?: boolean;
  kind?: InstallKind;
  execPath?: string;
  argv?: string[];
  platform?: NodeJS.Platform;
  homedir?: string;
  userprofile?: string;
  currentVersion?: string;
  latestVersion?: string;
  runInstaller?: (args: InstallerArgs) => Promise<{ ok: boolean; output: string }>;
  whichPraana?: () => string | null;
  versionOf?: (bin: string) => string | null;
  prepareWindowsSwap?: (exePath: string) => void;
}

let upgradeInFlight = false;

export function defaultUserPrefix(
  platform: string,
  home: string,
  userprofile?: string,
): string {
  if (platform === "win32") {
    return join(userprofile || home, ".local", "bin");
  }
  return join(home, ".local", "bin");
}

export function installerCommand(platform: string, prefix: string): string {
  if (platform === "win32") {
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${INSTALL_PS1_URL} -OutFile $env:TEMP\\praana-install.ps1; & $env:TEMP\\praana-install.ps1 -Prefix '${prefix.replace(/'/g, "''")}'"`;
  }
  const escaped = prefix.replace(/'/g, `'\\''`);
  return `curl -fsSL ${INSTALL_SH_URL} | sh -s -- --prefix '${escaped}'`;
}

function posix(path: string): string {
  return path.replace(/\\/g, "/");
}

function pathUnderPrefix(resolved: string, prefix: string): boolean {
  const a = posix(resolved);
  const b = posix(prefix).replace(/\/$/, "");
  return a === `${b}/praana` || a === `${b}/praana.exe` || a.startsWith(`${b}/`);
}

function defaultWhichPraana(): string | null {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", ["praana"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  const line = (result.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line || null;
}

function defaultVersionOf(bin: string): string | null {
  const result = spawnSync(bin, ["--version"], { encoding: "utf-8" });
  if (result.status !== 0) return null;
  const text = (result.stdout || result.stderr || "").trim();
  return text || null;
}

function defaultPrepareWindowsSwap(exePath: string): void {
  if (!existsSync(exePath)) return;
  const oldPath = `${exePath}.old`;
  try {
    renameSync(exePath, oldPath);
  } catch {
    // installer may still succeed if the file is not locked
  }
}

async function defaultRunInstaller(
  args: InstallerArgs,
): Promise<{ ok: boolean; output: string }> {
  const shell = args.platform === "win32" ? "cmd.exe" : "sh";
  const shellArgs = args.platform === "win32" ? ["/d", "/s", "/c", args.command] : ["-c", args.command];
  const result = spawnSync(shell, shellArgs, { encoding: "utf-8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { ok: result.status === 0, output };
}

export function beginUpgradeLock(): boolean {
  if (upgradeInFlight) return false;
  upgradeInFlight = true;
  return true;
}

export function endUpgradeLock(): void {
  upgradeInFlight = false;
}

export async function runUpgrade(opts: RunUpgradeOptions = {}): Promise<UpgradeResult> {
  const platform = opts.platform ?? process.platform;
  const execPath = opts.execPath ?? process.execPath;
  const kind =
    opts.kind ??
    classifyInstallKind({
      execPath,
      argv: opts.argv ?? process.argv,
    });

  if (kind === "source") {
    return {
      lines: [
        "This looks like a git checkout, not a release install.",
        "Update with: git pull && bun install",
      ],
      exitCode: 1,
      ranInstaller: false,
    };
  }

  const current = opts.currentVersion ?? APP_VERSION;
  if (
    !opts.force &&
    opts.latestVersion &&
    !isNewer(opts.latestVersion, current)
  ) {
    return {
      lines: [`Already up to date (${current}).`],
      exitCode: 0,
      ranInstaller: false,
    };
  }

  const home = opts.homedir ?? homedir();
  const prefix =
    kind === "standalone"
      ? dirname(execPath)
      : defaultUserPrefix(platform, home, opts.userprofile ?? process.env.USERPROFILE);

  if (platform === "win32" && kind === "standalone") {
    const exePath = join(prefix, "praana.exe");
    (opts.prepareWindowsSwap ?? defaultPrepareWindowsSwap)(exePath);
  }

  const command = installerCommand(platform, prefix);
  const runInstaller = opts.runInstaller ?? defaultRunInstaller;
  const installed = await runInstaller({ prefix, platform, command });
  if (!installed.ok) {
    return {
      lines: [
        "Upgrade failed.",
        installed.output.trim() || "installer exited non-zero",
      ],
      exitCode: 1,
      ranInstaller: true,
      prefix,
    };
  }

  const bin = join(prefix, platform === "win32" ? "praana.exe" : "praana");
  const versionOf = opts.versionOf ?? defaultVersionOf;
  const versionLine = versionOf(bin);
  const lines: string[] = [];
  if (installed.output.trim()) lines.push(installed.output.trim());
  if (versionLine) lines.push(versionLine);
  lines.push("Restart praana to use the new binary.");

  if (kind === "bun_global" || kind === "npm_global" || kind === "brew") {
    const resolved = (opts.whichPraana ?? defaultWhichPraana)();
    if (resolved && !pathUnderPrefix(resolved, prefix)) {
      lines.push(
        `Warning: PATH still resolves praana to ${resolved}. Put ${prefix} first, or run: ${kind === "npm_global" ? "npm rm -g praana" : kind === "brew" ? "brew uninstall praana" : "bun remove -g praana"}`,
      );
    }
  }

  return { lines, exitCode: 0, ranInstaller: true, prefix };
}
