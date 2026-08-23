/**
 * Structured git tools (issue #26) — first ship of the deterministic tools harness (#195).
 *
 * Returns verified JSON instead of raw porcelain text. Large diffs are ingested as
 * lossless `"diff"` artifacts with stub cards; DiffDistiller may fill stored summary
 * for stats only — it is not the prompt size-control path.
 */

import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import chalk from "chalk";
import { writeUiStderr } from "../ui.js";
import { findGitRoot, isGitRepo } from "../git-context.js";
import type { SandboxConfig } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "untracked"
  | "typechange"
  | "unknown";

export interface GitStatusEntry {
  path: string;
  status: GitFileStatus;
  /** Present for renames/copies. */
  origPath?: string;
}

export interface GitStatusSuccess {
  ok: true;
  branch: string | null;
  ahead: number;
  behind: number;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: GitStatusEntry[];
  conflicted: GitStatusEntry[];
}

export interface GitDiffHunk {
  oldStart: number;
  newStart: number;
  lines: string[];
}

export interface GitDiffFile {
  path: string;
  status: GitFileStatus;
  origPath?: string;
  hunks: GitDiffHunk[];
}

export interface GitDiffSuccess {
  ok: true;
  files: GitDiffFile[];
  stats: { insertions: number; deletions: number };
}

export interface GitCommitSuccess {
  ok: true;
  sha: string;
  summary: string;
  filesCommitted: string[];
  /** Set when message lacks a conventional `type:` prefix (warn only). */
  warning?: string;
}

export interface GitToolError {
  ok: false;
  error: string;
}

export type GitStatusResult = GitStatusSuccess | GitToolError;
export type GitDiffResult = GitDiffSuccess | GitToolError;
export type GitCommitResult = GitCommitSuccess | GitToolError;

export interface GitBranchEntry {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string | null;
  last_commit: { sha: string; date: string; subject: string };
  ahead: number;
  behind: number;
}

export interface GitBranchesSuccess {
  ok: true;
  base: string;
  current: string | null;
  branches: GitBranchEntry[];
}

export interface GitLogCommit {
  sha: string;
  author: string;
  date: string;
  subject: string;
  files_changed: number;
}

export interface GitLogSuccess {
  ok: true;
  commits: GitLogCommit[];
}

export type GitBranchesResult = GitBranchesSuccess | GitToolError;
export type GitLogResult = GitLogSuccess | GitToolError;

export interface GitToolsContext {
  cwd: string;
  editConfirm?: boolean;
  sandbox?: SandboxConfig;
  getAbortSignal?: () => AbortSignal | undefined;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const gitStatusSchema = z.object({});

const gitDiffSchema = z.object({
  staged: z
    .boolean()
    .optional()
    .describe("When true, show staged (index) diff; otherwise unstaged worktree diff"),
  path: z.string().optional().describe("Limit diff to a single path"),
  context: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe("Unified diff context lines (default: 3)"),
});

const gitCommitSchema = z.object({
  message: z.string().min(1).describe("Commit message (prefer conventional commits)"),
  paths: z
    .array(z.string())
    .optional()
    .describe("Stage only these paths before committing"),
  all: z
    .boolean()
    .optional()
    .describe("Stage all tracked modifications before committing (git commit -a)"),
});

const gitBranchesSchema = z.object({
  base: z.string().optional().describe("Base branch for ahead/behind (default: upstream, else main, else master)"),
  include_remote: z
    .boolean()
    .optional()
    .describe("Include remote-tracking branches (default: false)"),
  limit: z.number().int().min(1).max(100).optional().describe("Cap branch count (default: 50)"),
});

const gitLogSchema = z.object({
  branch: z.string().optional().describe("Branch or revision to show (default: HEAD)"),
  path: z.string().optional().describe("Limit history to a single path"),
  max_count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max commits to return (default: 20, hard cap 50)"),
  since: z.string().optional().describe("Show commits since date (e.g. '2 weeks ago' or ISO date)"),
});

const CONVENTIONAL_PREFIX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?:\s+/;

// ---------------------------------------------------------------------------
// Git subprocess
// ---------------------------------------------------------------------------

/** Mutable holder so tests can simulate a missing git binary. */
const gitBin = { path: "git" };

/** Test-only: override the git executable path (restore to `"git"` after). */
export function setGitExecutableForTests(path: string): void {
  gitBin.path = path;
}

export async function runGitAsync(
  cwd: string,
  args: string[],
  getAbortSignal?: () => AbortSignal | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const signal = getAbortSignal?.();
  return new Promise((resolve) => {
    const child = spawn(gitBin.path, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      const message =
        err.code === "ENOENT"
          ? "git executable not found"
          : err.message || "failed to spawn git";
      resolve({ code: 127, stdout: "", stderr: message });
    });
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Path + sandbox helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a tool path argument relative to the session cwd, then rewrite it as
 * a path relative to the repository root (git pathspecs are root-relative when
 * commands run with cwd=repoRoot).
 */
export function resolveRepoPath(
  sessionCwd: string,
  repoRoot: string,
  pathArg: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const abs = isAbsolute(pathArg)
    ? normalize(pathArg)
    : resolve(sessionCwd, pathArg);
  const rel = relative(repoRoot, abs);
  if (!rel) return { ok: true, path: "." };
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      ok: false,
      error: `Path is outside the git repository: ${pathArg}`,
    };
  }
  return { ok: true, path: rel.split("\\").join("/") };
}

function resolveSandboxPath(p: string): string {
  const expanded = p.replace(/^~/, homedir());
  const normalized = normalize(expanded);
  if (!existsSync(normalized)) return normalized;
  try {
    return realpathSync(normalized);
  } catch {
    return normalized;
  }
}

/** Return null if the path is allowed by the sandbox, else a human-readable error. */
export function sandboxBlockReason(
  path: string,
  sandbox: SandboxConfig | undefined,
): string | null {
  if (!sandbox?.enabled || sandbox.allowed_paths.length === 0) return null;

  const resolved = resolveSandboxPath(path);
  const allowed = sandbox.allowed_paths.some((ap) => {
    const apResolved = resolveSandboxPath(ap);
    return resolved === apResolved || resolved.startsWith(apResolved + "/");
  });

  return allowed
    ? null
    : `Blocked by sandbox: path not in allowed list: ${path}`;
}

function mapGitSpawnError(result: {
  code: number;
  stderr: string;
}): GitToolError | null {
  if (result.stderr.includes("git executable not found")) {
    return { ok: false, error: "git executable not found" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status parsing (porcelain=v2)
// ---------------------------------------------------------------------------

function mapXyChar(ch: string): GitFileStatus {
  switch (ch) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "U":
      return "unmerged";
    case "T":
      return "typechange";
    default:
      return "unknown";
  }
}

/** Prefer the more informative of index/worktree status chars. */
function pickStatus(x: string, y: string): GitFileStatus {
  if (x === "R" || y === "R") return "renamed";
  if (x === "C" || y === "C") return "copied";
  if (x === "U" || y === "U") return "unmerged";
  if (x !== "." && x !== " ") return mapXyChar(x);
  if (y !== "." && y !== " ") return mapXyChar(y);
  return "unknown";
}

/**
 * Parse `git status --porcelain=v2 -b` output into structured buckets.
 * Exported for unit tests.
 */
export function parsePorcelainV2(text: string): Omit<GitStatusSuccess, "ok"> {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  const conflicted: GitStatusEntry[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line) continue;

    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head === "(detached)" ? null : head;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    if (line.startsWith("? ")) {
      untracked.push({ path: line.slice(2), status: "untracked" });
      continue;
    }
    if (line.startsWith("! ")) continue;

    if (line.startsWith("u ")) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(10).join(" ");
      conflicted.push({
        path,
        status: pickStatus(xy[0] ?? "U", xy[1] ?? "U"),
      });
      continue;
    }

    if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
      const kind = line[0];
      const rest = line.slice(2);
      const xy = rest.slice(0, 2);
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      const afterXy = rest.slice(3); // skip "XY "
      const fields = afterXy.split(" ");
      // fields: sub mH mI mW hH hI [score] path...
      // type 1 path starts at index 6; type 2 adds rename/copy score at index 6.
      const pathStart = kind === "2" ? 7 : 6;
      const pathField = fields.slice(pathStart).join(" ");
      let path = pathField;
      let origPath: string | undefined;
      if (kind === "2" && pathField.includes("\t")) {
        const [newPath, oldPath] = pathField.split("\t");
        path = newPath ?? pathField;
        origPath = oldPath;
      }

      const status = pickStatus(x, y);
      const entry: GitStatusEntry = origPath ? { path, status, origPath } : { path, status };

      if (x === "U" || y === "U") {
        conflicted.push(entry);
      } else {
        if (x !== ".") staged.push({ ...entry, status: mapXyChar(x) === "unknown" ? status : mapXyChar(x) });
        if (y !== ".") unstaged.push({ ...entry, status: mapXyChar(y) === "unknown" ? status : mapXyChar(y) });
      }
    }
  }

  return { branch, ahead, behind, staged, unstaged, untracked, conflicted };
}

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * Parse unified diff text into structured file/hunk records.
 * Exported for unit tests.
 */
export function parseUnifiedDiff(text: string): {
  files: GitDiffFile[];
  stats: { insertions: number; deletions: number };
} {
  const files: GitDiffFile[] = [];
  let insertions = 0;
  let deletions = 0;
  let current: GitDiffFile | null = null;
  let currentHunk: GitDiffHunk | null = null;

  const flushHunk = () => {
    if (current && currentHunk) {
      current.hunks.push(currentHunk);
      currentHunk = null;
    }
  };
  const flushFile = () => {
    flushHunk();
    if (current) {
      files.push(current);
      current = null;
    }
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");

    if (line.startsWith("diff --git ")) {
      flushFile();
      // diff --git a/path b/path
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      const path = m?.[2] ?? m?.[1] ?? "unknown";
      current = { path, status: "modified", hunks: [] };
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.status = "renamed";
      current.origPath = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
      current.status = "renamed";
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      flushHunk();
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        newStart: Number(hunkMatch[2]),
        lines: [],
      };
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        insertions++;
        currentHunk.lines.push(line);
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        deletions++;
        currentHunk.lines.push(line);
      } else if (line.startsWith("\\") || line.startsWith(" ") || line === "") {
        currentHunk.lines.push(line.startsWith("\\") || line.startsWith(" ") ? line : ` ${line}`);
      } else if (line.startsWith("diff --git ")) {
        // handled above
      } else {
        // keep unknown hunk lines for fidelity
        currentHunk.lines.push(line);
      }
    }
  }

  flushFile();
  return { files, stats: { insertions, deletions } };
}

// ---------------------------------------------------------------------------
// Branches parsing
// ---------------------------------------------------------------------------

/**
 * Resolve the base branch for divergence calculations.
 * Priority: explicit arg → upstream of current → main → master → current branch.
 */
async function resolveBaseBranch(
  repoRoot: string,
  explicitBase: string | undefined,
  getAbortSignal?: () => AbortSignal | undefined,
): Promise<{ ok: true; base: string } | GitToolError> {
  if (explicitBase) {
    const trimmed = explicitBase.trim();
    if (!trimmed) return { ok: false, error: "base must not be empty" };
    // Verify the ref exists.
    const check = await runGitAsync(repoRoot, ["rev-parse", "--verify", trimmed], getAbortSignal);
    const spawnErr = mapGitSpawnError(check);
    if (spawnErr) return spawnErr;
    if (check.code !== 0) {
      return { ok: false, error: `Base branch not found: ${trimmed}` };
    }
    return { ok: true, base: trimmed };
  }

  // Try upstream of current branch.
  const upstream = await runGitAsync(
    repoRoot,
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    getAbortSignal,
  );
  if (upstream.code === 0) {
    const name = upstream.stdout.trim();
    if (name && name !== "@{u}") return { ok: true, base: name };
  }

  // Try main, then master.
  for (const candidate of ["main", "master"]) {
    const check = await runGitAsync(
      repoRoot,
      ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
      getAbortSignal,
    );
    if (check.code === 0) return { ok: true, base: candidate };
  }

  // Fallback: current branch itself (so current shows 0/0).
  const current = await runGitAsync(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], getAbortSignal);
  if (current.code === 0) {
    const name = current.stdout.trim();
    if (name && name !== "HEAD") return { ok: true, base: name };
  }

  // Last resort: any local branch.
  const anyBranch = await runGitAsync(
    repoRoot,
    ["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    getAbortSignal,
  );
  if (anyBranch.code === 0) {
    const first = anyBranch.stdout.split("\n").map((l) => l.trim()).find(Boolean);
    if (first) return { ok: true, base: first };
  }

  return { ok: false, error: "Cannot determine base branch (no upstream, main, or master found)" };
}

export async function runGitBranches(
  cwd: string,
  args: { base?: string; include_remote?: boolean; limit?: number },
  getAbortSignal?: () => AbortSignal | undefined,
  sandbox?: SandboxConfig,
): Promise<GitBranchesResult> {
  const repo = await ensureRepo(cwd, sandbox);
  if (!repo.ok) return repo;
  const repoRoot = repo.repoRoot;

  const limit = args.limit ?? 50;
  const includeRemote = args.include_remote ?? false;

  const baseResolved = await resolveBaseBranch(repoRoot, args.base, getAbortSignal);
  if (!baseResolved.ok) return baseResolved;
  const base = baseResolved.base;

  // Determine current branch (null when detached).
  const currentRes = await runGitAsync(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], getAbortSignal);
  const spawnCurrentErr = mapGitSpawnError(currentRes);
  if (spawnCurrentErr) return spawnCurrentErr;
  const rawCurrent = currentRes.stdout.trim();
  const current: string | null = rawCurrent === "HEAD" || !rawCurrent ? null : rawCurrent;

  // List branches via for-each-ref.
  const refs = includeRemote ? ["refs/heads/", "refs/remotes/"] : ["refs/heads/"];
  const format = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(objectname:short)%00%(committerdate:short)%00%(subject)%00%(HEAD)";
  const forEachArgs = ["for-each-ref", "--sort=-committerdate", `--format=${format}`, ...refs];
  const forEachRes = await runGitAsync(repoRoot, forEachArgs, getAbortSignal);
  const spawnForEachErr = mapGitSpawnError(forEachRes);
  if (spawnForEachErr) return spawnForEachErr;
  if (forEachRes.code !== 0) {
    return { ok: false, error: forEachRes.stderr.trim() || `git for-each-ref failed (exit ${forEachRes.code})` };
  }

  const lines = forEachRes.stdout.split("\n").filter((l) => l.length > 0);
  const branches: GitBranchEntry[] = [];

  for (const line of lines) {
    const parts = line.split("\x00");
    if (parts.length < 7) continue;
    const [refname, shortName, upstreamShort, shortSha, date, subject, headMarker] = parts;
    const isCurrent = headMarker === "*";
    const isRemote = refname.startsWith("refs/remotes/");
    const upstream = upstreamShort || null;

    // Compute ahead/behind vs base.
    let ahead = 0;
    let behind = 0;
    const refForRevList = shortName;
    if (refForRevList !== base) {
      const rev = await runGitAsync(
        repoRoot,
        ["rev-list", "--left-right", "--count", `${base}...${refForRevList}`],
        getAbortSignal,
      );
      if (rev.code === 0) {
        const m = rev.stdout.trim().match(/(\d+)\s+(\d+)/);
        if (m) {
          behind = Number(m[1]);
          ahead = Number(m[2]);
        } else {
          // Fallback: tab-separated.
          const tabParts = rev.stdout.trim().split(/\s+/);
          if (tabParts.length >= 2) {
            behind = Number(tabParts[0]) || 0;
            ahead = Number(tabParts[1]) || 0;
          }
        }
      }
      // On rev-list failure (e.g. base is remote ref not fetched), keep 0/0.
    }

    branches.push({
      name: shortName,
      current: isCurrent,
      remote: isRemote,
      upstream,
      last_commit: { sha: shortSha, date, subject },
      ahead,
      behind,
    });

    if (branches.length >= limit) break;
  }

  return { ok: true, base, current, branches };
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

/**
 * Parse `git log --pretty=format:'%H%x1f%an%x1f%aI%x1f%s' --name-only` output.
 * Exported for unit tests.
 */
export function parseGitLog(
  text: string,
): { sha: string; author: string; date: string; subject: string; files_changed: number }[] {
  const commits: { sha: string; author: string; date: string; subject: string; files_changed: number }[] = [];
  const lines = text.split("\n");
  let current: { sha: string; author: string; date: string; subject: string; files_changed: number } | null = null;

  const flush = () => {
    if (current) {
      commits.push(current);
      current = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (line.includes("\x1f")) {
      flush();
      const fields = line.split("\x1f");
      if (fields.length < 4) continue;
      const [sha, author, date, subject] = fields;
      if (!sha) continue;
      current = { sha, author, date, subject, files_changed: 0 };
    } else if (line.trim() === "") {
      continue;
    } else if (current) {
      current.files_changed += 1;
    }
  }
  flush();
  return commits;
}

export async function runGitLog(
  cwd: string,
  args: { branch?: string; path?: string; max_count?: number; since?: string },
  getAbortSignal?: () => AbortSignal | undefined,
  sandbox?: SandboxConfig,
): Promise<GitLogResult> {
  const repo = await ensureRepo(cwd, sandbox);
  if (!repo.ok) return repo;
  const repoRoot = repo.repoRoot;

  const maxCount = args.max_count ?? 20;
  const format = "%H%x1f%an%x1f%aI%x1f%s";
  const gitArgs = ["log", `--pretty=format:${format}`, "--name-only", `--max-count=${maxCount}`];

  if (args.since) {
    const trimmed = args.since.trim();
    if (!trimmed) return { ok: false, error: "since must not be empty" };
    gitArgs.push(`--since=${trimmed}`);
  }

  let revision: string | undefined;
  if (args.branch) {
    const trimmed = args.branch.trim();
    if (!trimmed) return { ok: false, error: "branch must not be empty" };
    // Verify branch exists.
    const check = await runGitAsync(repoRoot, ["rev-parse", "--verify", trimmed], getAbortSignal);
    const spawnErr = mapGitSpawnError(check);
    if (spawnErr) return spawnErr;
    if (check.code !== 0) {
      return { ok: false, error: `Branch or revision not found: ${trimmed}` };
    }
    revision = trimmed;
  }

  if (args.path) {
    const resolved = resolveRepoPath(cwd, repoRoot, args.path);
    if (!resolved.ok) return resolved;
    const pathBlocked = sandboxBlockReason(resolve(repoRoot, resolved.path), sandbox);
    if (pathBlocked) return { ok: false, error: pathBlocked };
    if (revision) gitArgs.push(revision);
    gitArgs.push("--", resolved.path);
  } else if (revision) {
    gitArgs.push(revision);
  }

  const result = await runGitAsync(repoRoot, gitArgs, getAbortSignal);
  const spawnErr = mapGitSpawnError(result);
  if (spawnErr) return spawnErr;
  if (result.code !== 0) {
    return { ok: false, error: result.stderr.trim() || `git log failed (exit ${result.code})` };
  }

  const commits = parseGitLog(result.stdout).map((c) => ({
    sha: c.sha.slice(0, 7),
    author: c.author,
    date: c.date,
    subject: c.subject,
    files_changed: c.files_changed,
  }));

  return { ok: true, commits };
}

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

async function ensureRepo(
  cwd: string,
  sandbox?: SandboxConfig,
): Promise<{ ok: true; repoRoot: string } | GitToolError> {
  if (!isGitRepo(cwd)) {
    return { ok: false, error: "not a git repository" };
  }
  const repoRoot = findGitRoot(cwd);
  const blocked = sandboxBlockReason(repoRoot, sandbox);
  if (blocked) return { ok: false, error: blocked };
  return { ok: true, repoRoot };
}

export async function runGitStatus(
  cwd: string,
  getAbortSignal?: () => AbortSignal | undefined,
  sandbox?: SandboxConfig,
): Promise<GitStatusResult> {
  const repo = await ensureRepo(cwd, sandbox);
  if (!repo.ok) return repo;

  const result = await runGitAsync(
    repo.repoRoot,
    ["status", "--porcelain=v2", "-b"],
    getAbortSignal,
  );
  const spawnErr = mapGitSpawnError(result);
  if (spawnErr) return spawnErr;
  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderr.trim() || `git status failed (exit ${result.code})`,
    };
  }
  const parsed = parsePorcelainV2(result.stdout);
  return { ok: true, ...parsed };
}

export async function runGitDiff(
  cwd: string,
  args: { staged?: boolean; path?: string; context?: number },
  getAbortSignal?: () => AbortSignal | undefined,
  sandbox?: SandboxConfig,
): Promise<GitDiffResult> {
  const repo = await ensureRepo(cwd, sandbox);
  if (!repo.ok) return repo;

  const context = args.context ?? 3;
  const gitArgs = ["diff", `--unified=${context}`, "--no-color", "--find-renames"];
  if (args.staged) gitArgs.push("--cached");
  if (args.path) {
    const resolved = resolveRepoPath(cwd, repo.repoRoot, args.path);
    if (!resolved.ok) return resolved;
    const pathBlocked = sandboxBlockReason(
      resolve(repo.repoRoot, resolved.path),
      sandbox,
    );
    if (pathBlocked) return { ok: false, error: pathBlocked };
    gitArgs.push("--", resolved.path);
  }

  const result = await runGitAsync(repo.repoRoot, gitArgs, getAbortSignal);
  const spawnErr = mapGitSpawnError(result);
  if (spawnErr) return spawnErr;
  // git diff returns 1 when differences exist with --exit-code; without it, 0 is fine.
  if (result.code !== 0 && result.stderr.trim()) {
    return {
      ok: false,
      error: result.stderr.trim() || `git diff failed (exit ${result.code})`,
    };
  }

  const parsed = parseUnifiedDiff(result.stdout);
  return { ok: true, ...parsed };
}

export async function runGitCommit(
  cwd: string,
  args: { message: string; paths?: string[]; all?: boolean },
  options?: {
    editConfirm?: boolean;
    sandbox?: SandboxConfig;
    getAbortSignal?: () => AbortSignal | undefined;
  },
): Promise<GitCommitResult> {
  const repo = await ensureRepo(cwd, options?.sandbox);
  if (!repo.ok) return repo;

  const message = args.message.trim();
  if (!message) {
    return { ok: false, error: "Commit message must not be empty" };
  }
  if (args.paths?.length && args.all) {
    return {
      ok: false,
      error: "Provide either paths or all=true, not both",
    };
  }

  const abort = options?.getAbortSignal;
  const repoRoot = repo.repoRoot;

  let repoPaths: string[] | undefined;
  if (args.paths?.length) {
    repoPaths = [];
    for (const p of args.paths) {
      const resolved = resolveRepoPath(cwd, repoRoot, p);
      if (!resolved.ok) return resolved;
      const pathBlocked = sandboxBlockReason(
        resolve(repoRoot, resolved.path),
        options?.sandbox,
      );
      if (pathBlocked) return { ok: false, error: pathBlocked };
      repoPaths.push(resolved.path);
    }
  }

  // Preview intended commit set BEFORE mutating the index (confirm-before-stage).
  let filesCommitted: string[] = [];
  if (args.all) {
    filesCommitted = [];
  } else if (repoPaths?.length) {
    filesCommitted = repoPaths;
  } else {
    const stagedDiff = await runGitAsync(
      repoRoot,
      ["diff", "--cached", "--name-only"],
      abort,
    );
    const spawnErr = mapGitSpawnError(stagedDiff);
    if (spawnErr) return spawnErr;
    filesCommitted = stagedDiff.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (filesCommitted.length === 0) {
      return { ok: false, error: "Nothing staged to commit" };
    }
  }

  if (options?.editConfirm) {
    const previewArgs = args.all
      ? ["diff", "HEAD", "--stat"]
      : repoPaths?.length
        ? ["diff", "HEAD", "--stat", "--", ...repoPaths]
        : ["diff", "--cached", "--stat"];
    const preview = await runGitAsync(repoRoot, previewArgs, abort);
    const spawnErr = mapGitSpawnError(preview);
    if (spawnErr) return spawnErr;
    writeUiStderr(chalk.dim("\n--- git commit preview ---"));
    writeUiStderr(chalk.cyan(message));
    if (preview.stdout.trim()) {
      writeUiStderr(preview.stdout.trimEnd());
    } else if (args.all) {
      writeUiStderr(chalk.dim("(will stage tracked modifications with -a)"));
    } else if (repoPaths?.length) {
      writeUiStderr(chalk.dim(`(paths: ${repoPaths.join(", ")})`));
    }
    const answer = await new Promise<string>((resolveAnswer) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      rl.question("Create commit? [y/N] ", (ans) => {
        rl.close();
        resolveAnswer(ans.trim().toLowerCase());
      });
    });
    if (answer !== "y" && answer !== "yes") {
      return { ok: false, error: "Commit cancelled by user" };
    }
  }

  // Stage only after confirmation so cancel leaves the index untouched.
  if (repoPaths?.length) {
    const add = await runGitAsync(repoRoot, ["add", "--", ...repoPaths], abort);
    const spawnErr = mapGitSpawnError(add);
    if (spawnErr) return spawnErr;
    if (add.code !== 0) {
      return {
        ok: false,
        error: add.stderr.trim() || `git add failed (exit ${add.code})`,
      };
    }
  }

  // Pathspec commit so pre-staged unrelated files are not included.
  const commitArgs = ["commit", "-m", message];
  if (args.all) commitArgs.splice(1, 0, "-a");
  if (repoPaths?.length) commitArgs.push("--", ...repoPaths);

  const commit = await runGitAsync(repoRoot, commitArgs, abort);
  const commitSpawnErr = mapGitSpawnError(commit);
  if (commitSpawnErr) return commitSpawnErr;
  if (commit.code !== 0) {
    return {
      ok: false,
      error: commit.stderr.trim() || commit.stdout.trim() || `git commit failed (exit ${commit.code})`,
    };
  }

  const shaResult = await runGitAsync(repoRoot, ["rev-parse", "HEAD"], abort);
  const shaSpawnErr = mapGitSpawnError(shaResult);
  if (shaSpawnErr) return shaSpawnErr;
  const sha = shaResult.stdout.trim();

  if (filesCommitted.length === 0 || args.all) {
    const names = await runGitAsync(
      repoRoot,
      ["show", "--pretty=format:", "--name-only", "HEAD"],
      abort,
    );
    const namesSpawnErr = mapGitSpawnError(names);
    if (namesSpawnErr) return namesSpawnErr;
    filesCommitted = names.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } else if (repoPaths?.length) {
    // Prefer the commit's actual name-only list (handles renames), filtered to pathspec intent.
    const names = await runGitAsync(
      repoRoot,
      ["show", "--pretty=format:", "--name-only", "HEAD"],
      abort,
    );
    if (names.code === 0) {
      const committed = names.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (committed.length > 0) filesCommitted = committed;
    }
  }

  const summaryLine =
    commit.stdout
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? message;

  const result: GitCommitSuccess = {
    ok: true,
    sha,
    summary: summaryLine,
    filesCommitted,
  };
  if (!CONVENTIONAL_PREFIX.test(message)) {
    result.warning =
      "Commit message does not use a conventional prefix (feat:/fix:/chore:/…). Consider following AGENTS.md conventions.";
  }
  return result;
}

export function createGitTools(ctx: GitToolsContext) {
  return {
    git_status: defineTool({
      description:
        "Return structured git working-tree status (branch, ahead/behind, staged/unstaged/untracked/conflicted). Prefer this over `shell git status` for agent decisions.",
      parameters: gitStatusSchema,
      execute: async (raw: unknown) => {
        const parsed = gitStatusSchema.safeParse(raw ?? {});
        if (!parsed.success) {
          return {
            ok: false,
            error: `Invalid arguments: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          } satisfies GitToolError;
        }
        return runGitStatus(ctx.cwd, ctx.getAbortSignal, ctx.sandbox);
      },
    }),

    git_diff: defineTool({
      description:
        "Return a structured git diff (files, hunks, insertion/deletion stats). Use staged=true for the index. Prefer this over `shell git diff`. Large diffs are stored as retrievable artifacts with stub cards in the prompt.",
      parameters: gitDiffSchema,
      execute: async (raw: unknown) => {
        const parsed = gitDiffSchema.safeParse(raw ?? {});
        if (!parsed.success) {
          return {
            ok: false,
            error: `Invalid arguments: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          } satisfies GitToolError;
        }
        return runGitDiff(ctx.cwd, parsed.data, ctx.getAbortSignal, ctx.sandbox);
      },
    }),

    git_commit: defineTool({
      description:
        "Create a git commit with guardrails. Provide message (required); optionally stage specific paths or all tracked modifications. Blocked in plan mode. Prefer conventional commit messages (feat:/fix:/…). Optional TTY confirmation when edit.confirm=true (default false). Does not push.",
      parameters: gitCommitSchema,
      execute: async (raw: unknown) => {
        const parsed = gitCommitSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: `Invalid arguments: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          } satisfies GitToolError;
        }
        return runGitCommit(ctx.cwd, parsed.data, {
          editConfirm: ctx.editConfirm,
          sandbox: ctx.sandbox,
          getAbortSignal: ctx.getAbortSignal,
        });
      },
    }),

    git_branches: defineTool({
      description:
        "List local branches (and optionally remote-tracking branches) with last commit and ahead/behind vs a base branch. Read-only, allowed in plan mode. Prefer this over shell git branch loops.",
      parameters: gitBranchesSchema,
      execute: async (raw: unknown) => {
        const parsed = gitBranchesSchema.safeParse(raw ?? {});
        if (!parsed.success) {
          return {
            ok: false,
            error: `Invalid arguments: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          } satisfies GitToolError;
        }
        return runGitBranches(ctx.cwd, parsed.data, ctx.getAbortSignal, ctx.sandbox);
      },
    }),

    git_log: defineTool({
      description:
        "Return recent commit history with structured fields (sha, author, date, subject, files_changed). Supports branch/revision, path, max_count, and since filters. Read-only, allowed in plan mode. Prefer this over shell git log parsing.",
      parameters: gitLogSchema,
      execute: async (raw: unknown) => {
        const parsed = gitLogSchema.safeParse(raw ?? {});
        if (!parsed.success) {
          return {
            ok: false,
            error: `Invalid arguments: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          } satisfies GitToolError;
        }
        return runGitLog(ctx.cwd, parsed.data, ctx.getAbortSignal, ctx.sandbox);
      },
    }),
  };
}
