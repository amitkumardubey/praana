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
import {
  closeSync,
  existsSync,
  openSync,
  realpathSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { delimiter, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const BUN_URL = "https://bun.sh";
export const INSTALL_SH_URL =
  "https://raw.githubusercontent.com/amitkumardubey/praana/main/install.sh";
export const INSTALL_PS1_URL =
  "https://raw.githubusercontent.com/amitkumardubey/praana/main/install.ps1";

const DEFAULT_PATHEXT = ".EXE;.CMD;.BAT;.COM";

/** Package root (the directory that holds package.json). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The three-line notice, with the installer command for `platform`. */
export function noticeText(platform = process.platform) {
  const installer =
    platform === "win32"
      ? `  irm ${INSTALL_PS1_URL} | iex`
      : `  curl -fsSL ${INSTALL_SH_URL} | sh`;
  return [
    "PRAANA runs on Bun (>= 1.4).",
    `If you have not installed Bun yet: install it from ${BUN_URL}, or use the standalone installer:`,
    installer,
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

/**
 * Best-effort write straight to the terminal, bypassing whatever captured our
 * stdout. npm >= 7 swallows a dependency's lifecycle output and only replays it
 * when the script fails, so a plain stdout write would never be seen by the
 * person running `npm i -g praana`. Returns false when there is no terminal
 * (CI, piped install, no controlling tty), so the caller falls back to stdout.
 */
function defaultWriteToTerminal(text, platform = process.platform) {
  if (platform === "win32") {
    // writeFileSync("CONOUT$") opens with O_TRUNC, which Windows rejects for a
    // console device. Open for write and writeSync instead.
    let fd;
    try {
      fd = openSync("CONOUT$", "w");
      writeSync(fd, text);
      return true;
    } catch {
      return false;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Nothing to do: the console handle is process-owned.
        }
      }
    }
  }
  try {
    writeFileSync("/dev/tty", text);
    return true;
  } catch {
    return false;
  }
}

/** npm sets npm_config_loglevel for lifecycle scripts; --silent maps to "silent". */
export function isSilentLogLevel(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase() === "silent";
}

/** Print the notice. Injectable for tests. */
export function writeNotice(text, options = {}) {
  const {
    stdout = process.stdout,
    useTerminal = true,
    writeToTerminal = (chunk) => defaultWriteToTerminal(chunk),
  } = options;
  if (useTerminal && writeToTerminal(text)) return "terminal";
  stdout.write(text);
  return "stdout";
}

/** Decide whether the notice is worth printing. Pure. */
export function shouldNotify({ bunPath, isDevCheckout, silent = false }) {
  return !bunPath && !isDevCheckout && !silent;
}

/**
 * Full decision, with PATH lookup and the git-checkout probe injected.
 *
 * @returns {{ notice: string | null, bunPath: string | null, isDevCheckout: boolean }}
 */
export function run(options = {}) {
  const {
    env = process.env,
    platform = process.platform,
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
  const silent = isSilentLogLevel(env.npm_config_loglevel);
  const notice = shouldNotify({ bunPath, isDevCheckout, silent })
    ? noticeText(platform)
    : null;
  return { notice, bunPath, isDevCheckout };
}

/** realpath when the path exists, otherwise an absolute path. */
function realpathOrResolve(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when this file is the script Node was asked to run. Compare realpaths on
 * both sides: `process.argv[1]` keeps the symlinked path the user typed while
 * `import.meta.url` is already resolved, so a plain resolve() mismatch would
 * silently skip the notice for `npm i -g` through a symlinked prefix.
 */
function isMainModule() {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return (
      realpathOrResolve(entry) === realpathOrResolve(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const { notice } = run();
    // CI has no terminal to write to; keep the plain stdout write there.
    if (notice) writeNotice(notice, { useTerminal: !process.env.CI });
  } catch {
    // A postinstall notice must never fail the install.
  }
  process.exitCode = 0;
}
