import { isAbsolute, relative, resolve } from "node:path";
import type { RiskHit } from "./classes.js";

const PKG = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3"]);
const PKG_SUB = new Set(["install", "add", "i"]);

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export function isOutsideCwd(cwd: string, relPath: string): boolean {
  const abs = resolvePath(cwd, relPath);
  const rel = relative(cwd, abs);
  if (rel === "") return false;
  return rel.startsWith("..") || isAbsolute(rel);
}

function collectWritePaths(toolName: string, args: Record<string, unknown>): string[] {
  if (toolName === "write_file" || toolName === "edit_file") {
    return typeof args.path === "string" ? [args.path] : [];
  }
  if (toolName === "batch_write" && Array.isArray(args.files)) {
    return args.files
      .map((f) => (f && typeof f === "object" && "path" in f ? (f as { path: unknown }).path : null))
      .filter((p): p is string => typeof p === "string");
  }
  if (toolName === "batch_edit" && Array.isArray(args.edits)) {
    return args.edits
      .map((e) => (e && typeof e === "object" && "path" in e ? (e as { path: unknown }).path : null))
      .filter((p): p is string => typeof p === "string");
  }
  return [];
}

export function shellArgv(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

export function stripShellPrefixes(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "sudo" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

function isShortForceCluster(tok: string): boolean {
  return tok.startsWith("-") && !tok.startsWith("--") && tok.length > 1 && tok.slice(1).includes("f");
}

function hasForceFlag(tokens: string[]): boolean {
  return tokens.some(
    (t) =>
      t === "-f" ||
      t === "--force" ||
      t === "--force-with-lease" ||
      t.startsWith("--force-with-lease=") ||
      isShortForceCluster(t),
  );
}

function classifyShell(command: string): RiskHit | null {
  const tokens = stripShellPrefixes(shellArgv(command));
  if (tokens.length === 0) return null;
  const [cmd, sub, third] = tokens;
  if (cmd === "rm") return { class: "rm", detail: command };
  if (cmd === "git" && sub === "reset") return { class: "git_reset", detail: command };
  if (cmd === "git" && sub === "push" && hasForceFlag(tokens.slice(2))) {
    return { class: "git_force_push", detail: command };
  }
  if (cmd === "git" && sub === "clean" && hasForceFlag(tokens.slice(2))) {
    return { class: "git_clean", detail: command };
  }
  if (cmd === "gh" && sub === "issue" && third === "close") {
    return { class: "gh_issue_close", detail: command };
  }
  if (cmd === "gh" && sub === "pr" && third === "merge") {
    return { class: "gh_pr_merge", detail: command };
  }
  if (PKG.has(cmd) && sub !== undefined && PKG_SUB.has(sub)) {
    return { class: "package_install", detail: command };
  }
  return null;
}

export function classifyRisk(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): RiskHit | null {
  if (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "batch_write" ||
    toolName === "batch_edit"
  ) {
    for (const p of collectWritePaths(toolName, args)) {
      if (isOutsideCwd(cwd, p)) {
        return { class: "write_outside_cwd", detail: resolvePath(cwd, p) };
      }
    }
    return null;
  }
  if (toolName === "shell" && typeof args.command === "string") {
    return classifyShell(args.command);
  }
  return null;
}
