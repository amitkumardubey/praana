/**
 * Redirect pi-tui hardcoded crash/debug logs from ~/.pi/agent/ to ~/.praana/logs.
 *
 * pi-tui writes its crash and debug-redraw logs to fixed paths under the user's
 * home directory (e.g. ~/.pi/agent/pi-crash.log). PRAANA keeps all of its own
 * logs under ~/.praana/logs, so while the TUI is active we patch
 * fs.writeFileSync / fs.appendFileSync to rewrite those specific paths.
 */

import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { appHomePath } from "../../app-identity.js";

// Use require() so we get the mutable CommonJS exports object; Bun's ESM
// namespace object makes fs.writeFileSync read-only.
const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");

const PI_AGENT_CRASH_LOG = "/.pi/agent/pi-crash.log";
const PI_AGENT_DEBUG_LOG = "/.pi/agent/pi-debug.log";

function praanaCrashLog(): string {
  return appHomePath("logs", "pi-crash.log");
}

function praanaDebugLog(): string {
  return appHomePath("logs", "pi-debug.log");
}

function ensureLogsDir(): void {
  mkdirSync(appHomePath("logs"), { recursive: true });
}

export function getPiTuiLogRedirectTarget(filePath: string): string | undefined {
  if (filePath.endsWith(PI_AGENT_CRASH_LOG)) return praanaCrashLog();
  if (filePath.endsWith(PI_AGENT_DEBUG_LOG)) return praanaDebugLog();
  return undefined;
}

function redirectPath(filePath: unknown): unknown {
  if (typeof filePath !== "string") return filePath;
  const target = getPiTuiLogRedirectTarget(filePath);
  return target ?? filePath;
}

function maybeEnsureLogsDir(filePath: unknown): void {
  if (typeof filePath !== "string") return;
  if (filePath === praanaCrashLog() || filePath === praanaDebugLog()) {
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

let installed = false;

export function installPiTuiLogRedirect(): void {
  if (installed) return;
  installed = true;
  fs.writeFileSync = patchedWriteFileSync;
  fs.appendFileSync = patchedAppendFileSync;
}

export function uninstallPiTuiLogRedirect(): void {
  if (!installed) return;
  installed = false;
  fs.writeFileSync = originalWriteFileSync;
  fs.appendFileSync = originalAppendFileSync;
}

export function isPiTuiLogRedirectInstalled(): boolean {
  return installed;
}
