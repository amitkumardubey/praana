/**
 * Redirect pi-tui hardcoded crash/debug logs from ~/.pi/agent/ to ~/.praana/logs.
 *
 * pi-tui writes its crash and debug-redraw logs to fixed paths under the user's
 * home directory (e.g. ~/.pi/agent/pi-crash.log). PRAANA keeps all of its own
 * logs under ~/.praana/logs, so while the TUI is active we patch
 * fs.writeFileSync / fs.appendFileSync to rewrite those specific paths.
 *
 * ## ADR: Why a global fs monkey-patch is the least-bad option
 *
 * pi-tui hardcodes these paths deep in its compiled crash handler
 * (`node_modules/@earendil-works/pi-tui/dist/tui.js`). There is no public
 * option, environment variable, or callback that lets callers override the log
 * destination. The alternatives are:
 *
 * 1. Fork pi-tui and maintain a patched build. High ongoing cost.
 * 2. Replace fs at the module loader level (e.g. import hook). More complex and
 *    still process-wide.
 * 3. Accept that crash logs leak into ~/.pi/agent/. Bad hygiene for PRAANA,
 *    which owns ~/.praana for all user-visible state.
 *
 * We therefore patch the CommonJS `node:fs` exports object, which pi-tui
 * receives, to rewrite only the two known pi-tui log paths. The patch is scoped
 * by install/uninstall calls and guarded by an `installed` flag, but it is
 * fundamentally a process-wide mutation. Keep the patch as small and
 * well-documented as possible, and treat removing it as a priority once pi-tui
 * exposes configurable log paths.
 *
 * TODO(#176-upstream): Remove this patch if pi-tui adds configurable crash/debug
 * log paths (e.g. `new TUI({ crashLogPath, debugLogPath })` or env vars).
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { normalize } from "node:path";
import { appHomePath } from "../../app-identity.js";

// Use require() so we get the mutable CommonJS exports object; Bun's ESM
// namespace object makes fs.writeFileSync read-only.
const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");

const PI_CRASH_BASENAME = "pi-crash.log";
const PI_DEBUG_BASENAME = "pi-debug.log";

function praanaCrashLog(): string {
  return appHomePath("logs", PI_CRASH_BASENAME);
}

function praanaDebugLog(): string {
  return appHomePath("logs", PI_DEBUG_BASENAME);
}

/**
 * Normalize a path for matching. Converts Windows backslashes to forward
 * slashes, collapses redundant separators, and removes trailing slashes so
 * we can inspect path components portably.
 */
function normalizeForMatch(filePath: string): string {
  return normalize(filePath.replace(/\\/g, "/")).replace(/\/+$/, "");
}

/**
 * Return true if `filePath` resolves to one of pi-tui's hardcoded agent logs.
 * Matches only paths whose final two directories are exactly `.pi/agent` so
 * unrelated directories that merely contain those substrings are not caught.
 * Handles both POSIX forward-slash and Windows backslash separators.
 */
function isPiAgentLogPath(filePath: string): boolean {
  const normalized = normalizeForMatch(filePath);
  const parts = normalized.split("/");
  if (parts.length < 3) return false;

  const base = parts[parts.length - 1];
  if (base !== PI_CRASH_BASENAME && base !== PI_DEBUG_BASENAME) return false;

  return (
    parts[parts.length - 3] === ".pi" && parts[parts.length - 2] === "agent"
  );
}

let ensuredLogsDir: string | undefined;

function ensureLogsDir(): void {
  const logsDir = appHomePath("logs");
  if (ensuredLogsDir === logsDir) return;
  mkdirSync(logsDir, { recursive: true });
  ensuredLogsDir = logsDir;
}

export function getPiTuiLogRedirectTarget(filePath: string): string | undefined {
  const normalized = normalizeForMatch(filePath);
  if (!isPiAgentLogPath(normalized)) return undefined;

  const base = normalized.split("/").pop();
  return base === PI_CRASH_BASENAME ? praanaCrashLog() : praanaDebugLog();
}

function redirectPath(filePath: unknown): unknown {
  if (typeof filePath !== "string") return filePath;
  const target = getPiTuiLogRedirectTarget(filePath);
  return target ?? filePath;
}

function maybeEnsureLogsDir(filePath: unknown): void {
  if (typeof filePath !== "string") return;
  const normalized = normalize(filePath);
  if (normalized === praanaCrashLog() || normalized === praanaDebugLog()) {
    ensureLogsDir();
  }
}

const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalAppendFileSync = fs.appendFileSync.bind(fs);

function patchedWriteFileSync(
  ...args: Parameters<typeof fs.writeFileSync>
): ReturnType<typeof fs.writeFileSync> {
  args[0] = redirectPath(args[0]) as typeof args[0];
  maybeEnsureLogsDir(args[0]);
  return originalWriteFileSync(...args);
}

function patchedAppendFileSync(
  ...args: Parameters<typeof fs.appendFileSync>
): ReturnType<typeof fs.appendFileSync> {
  args[0] = redirectPath(args[0]) as typeof args[0];
  maybeEnsureLogsDir(args[0]);
  return originalAppendFileSync(...args);
}

// The pi-tui crash handler uses fs.writeFileSync today. If it ever switches to
// fs.promises.writeFile we want the redirect to keep working, so patch the
// promise variants too. These are restored in uninstallPiTuiLogRedirect().
const originalPromisesWriteFile = fs.promises.writeFile.bind(fs.promises);
const originalPromisesAppendFile = fs.promises.appendFile.bind(fs.promises);

async function patchedPromisesWriteFile(
  ...args: Parameters<typeof fs.promises.writeFile>
): ReturnType<typeof fs.promises.writeFile> {
  args[0] = redirectPath(args[0]) as typeof args[0];
  maybeEnsureLogsDir(args[0]);
  return originalPromisesWriteFile(...args);
}

async function patchedPromisesAppendFile(
  ...args: Parameters<typeof fs.promises.appendFile>
): ReturnType<typeof fs.promises.appendFile> {
  args[0] = redirectPath(args[0]) as typeof args[0];
  maybeEnsureLogsDir(args[0]);
  return originalPromisesAppendFile(...args);
}

let installed = false;

export function installPiTuiLogRedirect(): void {
  if (installed) return;
  installed = true;
  fs.writeFileSync = patchedWriteFileSync;
  fs.appendFileSync = patchedAppendFileSync;
  fs.promises.writeFile = patchedPromisesWriteFile;
  fs.promises.appendFile = patchedPromisesAppendFile;
}

export function uninstallPiTuiLogRedirect(): void {
  if (!installed) return;
  installed = false;
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFileSync = originalAppendFileSync;
  fs.promises.writeFile = originalPromisesWriteFile;
  fs.promises.appendFile = originalPromisesAppendFile;
}

export function isPiTuiLogRedirectInstalled(): boolean {
  return installed;
}

/**
 * Rewrite the error message emitted by pi-tui's crash handler so it points the
 * user at the Praana log path instead of the hardcoded ~/.pi/agent path.
 */
export function rewritePiTuiCrashErrorMessage(message: string): string {
  const target = praanaCrashLog();
  // pi-tui currently writes: "Debug log written to: /home/user/.pi/agent/pi-crash.log"
  // Match the prefix and any path ending in the known basename so the rewrite
  // survives small upstream wording changes.
  return message.replace(
    /Debug log written to: .+/,
    `Debug log written to: ${target}`,
  );
}
