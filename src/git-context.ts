/**
 * Shared git repository context helpers.
 *
 * Used by agent-facing git tools (#26), session scope keys, and status chrome.
 * Always shells out to `git` — no isomorphic-git / simple-git dependency.
 */

import { spawnSync } from "node:child_process";

export interface GitContext {
  /** Absolute repo root when inside a work tree; otherwise the input cwd. */
  repoRoot: string;
  /** Current branch, or null when detached HEAD / not a repo. */
  branch: string | null;
  /** True when cwd is inside a git work tree. */
  isRepo: boolean;
  /** True when the work tree has staged, unstaged, or untracked changes. */
  isDirty: boolean;
}

function runGit(
  cwd: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; stderr: string; code: number | null } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return {
      ok: false,
      stderr: (result.stderr ?? result.error?.message ?? "").trim(),
      code: result.status,
    };
  }
  return { ok: true, stdout: (result.stdout ?? "").trimEnd() };
}

/** Find git root of the given directory, or return the directory itself. */
export function findGitRoot(cwd: string): string {
  const result = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) return cwd;
  const root = result.stdout.trim();
  return root || cwd;
}

/** True when cwd is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  const result = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

/** Current git branch, or null when detached HEAD or not in a git repo. */
export function findGitBranch(cwd: string): string | null {
  const result = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!result.ok) return null;
  const branch = result.stdout.trim();
  if (!branch || branch === "HEAD") return null;
  return branch;
}

/** True when the work tree has any staged/unstaged/untracked changes. */
export function isGitDirty(cwd: string): boolean {
  const result = runGit(cwd, ["status", "--porcelain"]);
  if (!result.ok) return false;
  return result.stdout.trim().length > 0;
}

/** Session-scoped git snapshot for tools and chrome. */
export function getGitContext(cwd: string): GitContext {
  const isRepo = isGitRepo(cwd);
  if (!isRepo) {
    return {
      repoRoot: cwd,
      branch: null,
      isRepo: false,
      isDirty: false,
    };
  }
  return {
    repoRoot: findGitRoot(cwd),
    branch: findGitBranch(cwd),
    isRepo: true,
    isDirty: isGitDirty(cwd),
  };
}
