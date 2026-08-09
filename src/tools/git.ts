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
import chalk from "chalk";
import { writeUiStderr } from "../ui.js";
import { getGitContext, isGitRepo } from "../git-context.js";

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

export interface GitToolsContext {
  cwd: string;
  editConfirm?: boolean;
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

const CONVENTIONAL_PREFIX =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(.+\))?!?:\s+/;

// ---------------------------------------------------------------------------
// Git subprocess
// ---------------------------------------------------------------------------

export async function runGitAsync(
  cwd: string,
  args: string[],
  getAbortSignal?: () => AbortSignal | undefined,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const signal = getAbortSignal?.();
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
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

    child.on("error", (err) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
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
// Tool factories
// ---------------------------------------------------------------------------

async function ensureRepo(
  cwd: string,
): Promise<{ ok: true } | GitToolError> {
  if (!isGitRepo(cwd)) {
    return { ok: false, error: "not a git repository" };
  }
  return { ok: true };
}

export async function runGitStatus(
  cwd: string,
  getAbortSignal?: () => AbortSignal | undefined,
): Promise<GitStatusResult> {
  const repo = await ensureRepo(cwd);
  if (!repo.ok) return repo;

  const ctx = getGitContext(cwd);
  const result = await runGitAsync(
    ctx.repoRoot,
    ["status", "--porcelain=v2", "-b"],
    getAbortSignal,
  );
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
): Promise<GitDiffResult> {
  const repo = await ensureRepo(cwd);
  if (!repo.ok) return repo;

  const ctx = getGitContext(cwd);
  const context = args.context ?? 3;
  const gitArgs = ["diff", `--unified=${context}`, "--no-color", "--find-renames"];
  if (args.staged) gitArgs.push("--cached");
  if (args.path) {
    gitArgs.push("--", args.path);
  }

  const result = await runGitAsync(ctx.repoRoot, gitArgs, getAbortSignal);
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
    getAbortSignal?: () => AbortSignal | undefined;
  },
): Promise<GitCommitResult> {
  const repo = await ensureRepo(cwd);
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

  const ctx = getGitContext(cwd);
  const abort = options?.getAbortSignal;

  if (args.paths?.length) {
    const add = await runGitAsync(ctx.repoRoot, ["add", "--", ...args.paths], abort);
    if (add.code !== 0) {
      return {
        ok: false,
        error: add.stderr.trim() || `git add failed (exit ${add.code})`,
      };
    }
  }

  // Preview staged changes for confirmation / result summary
  const stagedDiff = await runGitAsync(
    ctx.repoRoot,
    ["diff", "--cached", "--name-only"],
    abort,
  );
  let filesCommitted = stagedDiff.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  if (args.all) {
    // -a stages tracked modifications; capture names after commit via show
    filesCommitted = [];
  } else if (filesCommitted.length === 0) {
    return { ok: false, error: "Nothing staged to commit" };
  }

  if (options?.editConfirm) {
    const preview = await runGitAsync(
      ctx.repoRoot,
      args.all
        ? ["diff", "HEAD", "--stat"]
        : ["diff", "--cached", "--stat"],
      abort,
    );
    writeUiStderr(chalk.dim("\n--- git commit preview ---"));
    writeUiStderr(chalk.cyan(message));
    if (preview.stdout.trim()) {
      writeUiStderr(preview.stdout.trimEnd());
    } else if (args.all) {
      writeUiStderr(chalk.dim("(will stage tracked modifications with -a)"));
    }
    const answer = await new Promise<string>((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      rl.question("Create commit? [y/N] ", (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase());
      });
    });
    if (answer !== "y" && answer !== "yes") {
      return { ok: false, error: "Commit cancelled by user" };
    }
  }

  const commitArgs = ["commit", "-m", message];
  if (args.all) commitArgs.splice(1, 0, "-a");

  const commit = await runGitAsync(ctx.repoRoot, commitArgs, abort);
  if (commit.code !== 0) {
    return {
      ok: false,
      error: commit.stderr.trim() || commit.stdout.trim() || `git commit failed (exit ${commit.code})`,
    };
  }

  const shaResult = await runGitAsync(ctx.repoRoot, ["rev-parse", "HEAD"], abort);
  const sha = shaResult.stdout.trim();

  if (filesCommitted.length === 0) {
    const names = await runGitAsync(
      ctx.repoRoot,
      ["show", "--pretty=format:", "--name-only", "HEAD"],
      abort,
    );
    filesCommitted = names.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
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
        return runGitStatus(ctx.cwd, ctx.getAbortSignal);
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
        return runGitDiff(ctx.cwd, parsed.data, ctx.getAbortSignal);
      },
    }),

    git_commit: defineTool({
      description:
        "Create a git commit with guardrails. Provide message (required); optionally stage specific paths or all tracked modifications. Blocked in plan mode. Prefer conventional commit messages (feat:/fix:/…). Does not push.",
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
          getAbortSignal: ctx.getAbortSignal,
        });
      },
    }),
  };
}
