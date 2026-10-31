#!/usr/bin/env node
/**
 * Non-fatal postinstall notice for Node-only machines.
 *
 * `npm i -g praana` on a machine without Bun installs fine, then `praana` dies
 * with `/usr/bin/env: 'bun': No such file or directory`. Say so once, at install
 * time, and point at Bun and at the standalone installer.
 *
 * Rules:
 *   - never fail the install (everything is wrapped, exit code stays 0)
 *   - print nothing when `bun` is on PATH
 *   - print nothing inside a git checkout (the repo's own `npm/bun install`),
 *     which is how this script avoids nagging contributors
 *
 * Plain Node, no dependencies, ESM (package.json has "type": "module").
 */
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const BUN_URL = "https://bun.sh";
export const INSTALL_SH_URL =
  "https://raw.githubusercontent.com/amitkumardubey/praana/main/install.sh";

const DEFAULT_PATHEXT = ".EXE;.CMD;.BAT;.COM";

/** Package root (the directory that holds package.json). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The three-line notice. */
export function noticeText() {
  return [
    "PRAANA runs on Bun (>= 1.4).",
    `Install Bun from ${BUN_URL}, or use the standalone installer:`,
    `  curl -fsSL ${INSTALL_SH_URL} | sh`,
    "",
  ].join("\n");
}

function defaultIsExecutableFile(candidate, platform = process.platform) {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    // Windows has no +x bit; a regular bun.exe / bun.cmd is enough.
    if (platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/**
 * `which`-style lookup with no spawning and no shell. Pure: PATH, platform and
 * the file probe are injected so tests do not need a real bun on disk.
 *
 * @returns {string | null} absolute candidate path, or null when not found
 */
export function findOnPath(command, options = {}) {
  const {
    pathValue = process.env.PATH ?? "",
    platform = process.platform,
    pathExt = process.env.PATHEXT ?? DEFAULT_PATHEXT,
    isExecutableFile = (candidate) => defaultIsExecutableFile(candidate, platform),
  } = options;

  const separator = platform === "win32" ? ";" : delimiter;
  const joinFor = platform === "win32" ? win32.join : join;
  const dirs = pathValue.split(separator).filter(Boolean);
  const names =
    platform === "win32"
      ? [
          command,
          ...pathExt
            .split(";")
            .filter(Boolean)
            .map((ext) => command + ext.toLowerCase()),
        ]
      : [command];

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = joinFor(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** Decide whether the notice is worth printing. Pure. */
export function shouldNotify({ bunPath, isDevCheckout }) {
  return !bunPath && !isDevCheckout;
}

/**
 * Full decision, with PATH lookup and the git-checkout probe injected.
 *
 * @returns {{ notice: string | null, bunPath: string | null, isDevCheckout: boolean }}
 */
export function run(options = {}) {
  const {
    env = process.env,
    packageRoot = PACKAGE_ROOT,
    exists = existsSync,
    find = findOnPath,
  } = options;

  const bunPath = find("bun", {
    pathValue: env.PATH ?? "",
    pathExt: env.PATHEXT ?? DEFAULT_PATHEXT,
  });
  // A git checkout is the development tree: `bun install` / `npm install` here
  // must stay quiet. Published tarballs never contain `.git`, so registry
  // installs (global or as a dependency) are unaffected by this guard.
  const isDevCheckout = exists(join(packageRoot, ".git"));
  const notice = shouldNotify({ bunPath, isDevCheckout }) ? noticeText() : null;
  return { notice, bunPath, isDevCheckout };
}

function isMainModule() {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return resolve(entry) === resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const { notice } = run();
    if (notice) process.stdout.write(notice);
  } catch {
    // A postinstall notice must never fail the install.
  }
  process.exitCode = 0;
}
