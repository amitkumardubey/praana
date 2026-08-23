import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  createGitTools,
  parseGitLog,
  parsePorcelainV2,
  parseUnifiedDiff,
  resolveRepoPath,
  runGitAsync,
  runGitBranches,
  runGitCommit,
  runGitDiff,
  runGitLog,
  runGitStatus,
  setGitExecutableForTests,
} from "../src/tools/git.js";
import { getGitContext, isGitRepo } from "../src/git-context.js";

const testDir = "/tmp/praana-test-git-tools";
const hasGit = (() => {
  const r = spawnSync("git", ["--version"], { stdio: "ignore" });
  return r.status === 0;
})();

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Praana Test",
      GIT_AUTHOR_EMAIL: "test@praana.local",
      GIT_COMMITTER_NAME: "Praana Test",
      GIT_COMMITTER_EMAIL: "test@praana.local",
    },
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function setupRepo() {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });
  git(testDir, ["init", "-b", "main"]);
  git(testDir, ["config", "user.email", "test@praana.local"]);
  git(testDir, ["config", "user.name", "Praana Test"]);
  writeFileSync(join(testDir, "readme.md"), "hello\n");
  git(testDir, ["add", "readme.md"]);
  git(testDir, ["commit", "-m", "chore: initial"]);
}

describe("parsePorcelainV2", () => {
  it("parses branch headers and change buckets", () => {
    const text = [
      "# branch.oid abc",
      "# branch.head main",
      "# branch.ab +2 -1",
      "1 M. N... 100644 100644 100644 h1 h2 src/a.ts",
      "1 .M N... 100644 100644 100644 h1 h2 src/b.ts",
      "? untracked.txt",
      "u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.ts",
    ].join("\n");

    const parsed = parsePorcelainV2(text);
    expect(parsed.branch).toBe("main");
    expect(parsed.ahead).toBe(2);
    expect(parsed.behind).toBe(1);
    expect(parsed.staged).toEqual([{ path: "src/a.ts", status: "modified" }]);
    expect(parsed.unstaged).toEqual([{ path: "src/b.ts", status: "modified" }]);
    expect(parsed.untracked).toEqual([{ path: "untracked.txt", status: "untracked" }]);
    expect(parsed.conflicted[0]?.path).toBe("conflict.ts");
  });

  it("parses renames", () => {
    const text = "2 R. N... 100644 100644 100644 h1 h2 R100 new.ts\told.ts";
    const parsed = parsePorcelainV2(text);
    expect(parsed.staged[0]).toEqual({
      path: "new.ts",
      status: "renamed",
      origPath: "old.ts",
    });
  });
});

describe("parseUnifiedDiff", () => {
  it("extracts files, hunks, and stats", () => {
    const text = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " line1",
      "-old",
      "+new",
      "+extra",
      " line3",
      "diff --git a/src/b.ts b/src/b.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/b.ts",
      "@@ -0,0 +1,1 @@",
      "+hello",
    ].join("\n");

    const parsed = parseUnifiedDiff(text);
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]?.path).toBe("src/a.ts");
    expect(parsed.files[0]?.hunks[0]?.oldStart).toBe(1);
    expect(parsed.files[1]?.status).toBe("added");
    expect(parsed.stats.insertions).toBe(3);
    expect(parsed.stats.deletions).toBe(1);
  });
});

describe("getGitContext", () => {
  it("reports non-repo cwd", () => {
    const empty = "/tmp/praana-test-git-tools-empty";
    if (existsSync(empty)) rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    const ctx = getGitContext(empty);
    expect(ctx.isRepo).toBe(false);
    expect(ctx.branch).toBeNull();
    expect(isGitRepo(empty)).toBe(false);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe.skipIf(!hasGit)("git tools integration", () => {
  beforeEach(() => {
    setupRepo();
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("returns not a git repository outside a repo", async () => {
    const empty = "/tmp/praana-test-git-tools-norepo";
    if (existsSync(empty)) rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    const status = await runGitStatus(empty);
    expect(status).toEqual({ ok: false, error: "not a git repository" });
    rmSync(empty, { recursive: true, force: true });
  });

  it("git_status reports dirty tree buckets", async () => {
    writeFileSync(join(testDir, "readme.md"), "hello\nworld\n");
    writeFileSync(join(testDir, "new.txt"), "fresh\n");
    git(testDir, ["add", "readme.md"]);

    const status = await runGitStatus(testDir);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.branch).toBe("main");
    expect(status.staged.some((e) => e.path === "readme.md")).toBe(true);
    expect(status.untracked.some((e) => e.path === "new.txt")).toBe(true);
  });

  it("git_diff returns structured hunks for unstaged changes", async () => {
    writeFileSync(join(testDir, "readme.md"), "hello\nchanged\n");
    const diff = await runGitDiff(testDir, {});
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.files.length).toBeGreaterThan(0);
    expect(diff.files[0]?.path).toBe("readme.md");
    expect(diff.stats.insertions + diff.stats.deletions).toBeGreaterThan(0);
  });

  it("git_commit creates a commit and warns without conventional prefix", async () => {
    writeFileSync(join(testDir, "readme.md"), "hello\nv2\n");
    const result = await runGitCommit(testDir, {
      message: "update readme",
      paths: ["readme.md"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sha.length).toBeGreaterThanOrEqual(7);
    expect(result.filesCommitted).toContain("readme.md");
    expect(result.warning).toMatch(/conventional/i);
  });

  it("git_commit accepts conventional messages without warning", async () => {
    writeFileSync(join(testDir, "readme.md"), "hello\nv3\n");
    const result = await runGitCommit(testDir, {
      message: "fix: correct readme",
      paths: ["readme.md"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBeUndefined();
  });

  it("createGitTools registers execute handlers", async () => {
    const tools = createGitTools({ cwd: testDir });
    const status = await tools.git_status.execute({});
    expect(status.ok).toBe(true);
  });

  it("rejects empty commit when nothing is staged", async () => {
    const result = await runGitCommit(testDir, { message: "feat: noop" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Nothing staged/i);
  });

  it("git_commit with paths does not include unrelated pre-staged files", async () => {
    writeFileSync(join(testDir, "a.txt"), "a\n");
    writeFileSync(join(testDir, "b.txt"), "b\n");
    git(testDir, ["add", "a.txt", "b.txt"]);
    git(testDir, ["commit", "-m", "chore: add a and b"]);

    writeFileSync(join(testDir, "a.txt"), "a2\n");
    writeFileSync(join(testDir, "b.txt"), "b2\n");
    git(testDir, ["add", "a.txt"]); // pre-staged unrelated file

    const result = await runGitCommit(testDir, {
      message: "fix: only b",
      paths: ["b.txt"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.filesCommitted).toEqual(["b.txt"]);
    expect(result.filesCommitted).not.toContain("a.txt");

    // a.txt remains staged for a later commit
    const status = await runGitStatus(testDir);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.staged.some((e) => e.path === "a.txt")).toBe(true);
  });

  it("resolves path args relative to session cwd, not repo root", async () => {
    const sub = join(testDir, "packages", "foo");
    mkdirSync(join(sub, "src"), { recursive: true });
    writeFileSync(join(sub, "src", "a.ts"), "export const a = 1;\n");
    git(testDir, ["add", "packages/foo/src/a.ts"]);
    git(testDir, ["commit", "-m", "chore: add package file"]);

    writeFileSync(join(sub, "src", "a.ts"), "export const a = 2;\n");
    const diff = await runGitDiff(sub, { path: "src/a.ts" });
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.files.some((f) => f.path === "packages/foo/src/a.ts")).toBe(true);
    expect(diff.stats.insertions + diff.stats.deletions).toBeGreaterThan(0);
  });

  it("cancel after confirm does not leave newly staged paths", async () => {
    writeFileSync(join(testDir, "readme.md"), "hello\ncancel-me\n");
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", {
      value: Readable.from(["n\n"]),
      configurable: true,
    });
    try {
      const result = await runGitCommit(
        testDir,
        { message: "feat: should cancel", paths: ["readme.md"] },
        { editConfirm: true },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/cancelled/i);
    } finally {
      Object.defineProperty(process, "stdin", {
        value: originalStdin,
        configurable: true,
      });
    }

    const status = await runGitStatus(testDir);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.staged.some((e) => e.path === "readme.md")).toBe(false);
    expect(status.unstaged.some((e) => e.path === "readme.md")).toBe(true);
  });

  it("blocks git tools when sandbox allowlist excludes the repo", async () => {
    const tools = createGitTools({
      cwd: testDir,
      sandbox: { enabled: true, allowed_paths: ["/tmp/praana-sandbox-elsewhere"] },
    });
    const status = await tools.git_status.execute({});
    expect(status.ok).toBe(false);
    if (status.ok) return;
    expect(status.error).toMatch(/sandbox/i);
  });

  it("runGitAsync returns structured error when git binary is missing", async () => {
    setGitExecutableForTests("/nonexistent/praana-missing-git");
    try {
      const result = await runGitAsync(testDir, ["status"]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/git executable not found/i);
    } finally {
      setGitExecutableForTests("git");
    }
  });
});

describe("parseGitLog", () => {
  it("parses header lines and counts files", () => {
    const text = [
      "abc123def456\x1fAlice\x1f2026-08-13T10:00:00+05:30\x1ffeat: first",
      "src/a.ts",
      "src/b.ts",
      "",
      "def789abc123\x1fBob\x1f2026-08-13T11:00:00+05:30\x1ffix: second",
      "",
      "789abc123def\x1fCarol\x1f2026-08-13T12:00:00+05:30\x1fchore: third",
      "only.txt",
    ].join("\n");
    const commits = parseGitLog(text);
    expect(commits).toHaveLength(3);
    expect(commits[0]).toEqual({
      sha: "abc123def456",
      author: "Alice",
      date: "2026-08-13T10:00:00+05:30",
      subject: "feat: first",
      files_changed: 2,
    });
    expect(commits[1]?.files_changed).toBe(0);
    expect(commits[2]?.files_changed).toBe(1);
  });

  it("returns empty for empty input", () => {
    expect(parseGitLog("")).toEqual([]);
  });
});

describe.skipIf(!hasGit)("git_branches integration", () => {
  beforeEach(() => {
    setupRepo();
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("returns branches with current flag and ahead/behind", async () => {
    // Create a diverged branch: feat/foo from main, then advance main.
    git(testDir, ["checkout", "-b", "feat/foo"]);
    writeFileSync(join(testDir, "feat.txt"), "foo\n");
    git(testDir, ["add", "feat.txt"]);
    git(testDir, ["commit", "-m", "feat: foo branch"]);

    git(testDir, ["checkout", "main"]);
    writeFileSync(join(testDir, "main.txt"), "main\n");
    git(testDir, ["add", "main.txt"]);
    git(testDir, ["commit", "-m", "fix: main advance"]);

    const result = await runGitBranches(testDir, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.base).toBe("main");
    expect(result.current).toBe("main");
    expect(result.branches.length).toBe(2);

    const feat = result.branches.find((b) => b.name === "feat/foo");
    expect(feat).toBeDefined();
    expect(feat?.current).toBe(false);
    expect(feat?.remote).toBe(false);
    expect(feat?.ahead).toBe(1);
    expect(feat?.behind).toBe(1);

    const main = result.branches.find((b) => b.name === "main");
    expect(main?.current).toBe(true);
    expect(main?.ahead).toBe(0);
    expect(main?.behind).toBe(0);
  });

  it("respects limit", async () => {
    git(testDir, ["checkout", "-b", "feat/a"]);
    writeFileSync(join(testDir, "a.txt"), "a\n");
    git(testDir, ["add", "a.txt"]);
    git(testDir, ["commit", "-m", "feat: a"]);
    git(testDir, ["checkout", "main"]);
    git(testDir, ["checkout", "-b", "feat/b"]);
    writeFileSync(join(testDir, "b.txt"), "b\n");
    git(testDir, ["add", "b.txt"]);
    git(testDir, ["commit", "-m", "feat: b"]);
    git(testDir, ["checkout", "main"]);

    const result = await runGitBranches(testDir, { limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.branches).toHaveLength(1);
  });

  it("returns error for unknown base", async () => {
    const result = await runGitBranches(testDir, { base: "nope-branch" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/i);
  });

  it("supports explicit base and include_remote=false by default", async () => {
    git(testDir, ["checkout", "-b", "feat/explicit"]);
    writeFileSync(join(testDir, "explicit.txt"), "x\n");
    git(testDir, ["add", "explicit.txt"]);
    git(testDir, ["commit", "-m", "feat: explicit"]);
    git(testDir, ["checkout", "main"]);

    const result = await runGitBranches(testDir, { base: "feat/explicit" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.base).toBe("feat/explicit");
    expect(result.branches.every((b) => !b.remote)).toBe(true);
  });

  it("returns not a git repository outside a repo", async () => {
    const empty = "/tmp/praana-test-git-tools-norepo-branches";
    if (existsSync(empty)) rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    const result = await runGitBranches(empty, {});
    expect(result).toEqual({ ok: false, error: "not a git repository" });
    rmSync(empty, { recursive: true, force: true });
  });

  it("createGitTools git_branches is read-only under plan mode semantics", async () => {
    // git_branches is not in PLAN_MODE_BLOCKED_TOOLS, so it should succeed via tool execute.
    const tools = createGitTools({ cwd: testDir });
    const result = await tools.git_branches.execute({});
    expect(result.ok).toBe(true);
  });
});

describe.skipIf(!hasGit)("git_log integration", () => {
  beforeEach(() => {
    setupRepo();
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("returns recent commits with files_changed", async () => {
    writeFileSync(join(testDir, "readme.md"), "hello\nv2\n");
    git(testDir, ["commit", "-am", "fix: second commit"]);

    const result = await runGitLog(testDir, { max_count: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commits.length).toBeGreaterThanOrEqual(2);
    expect(result.commits[0]?.subject).toBe("fix: second commit");
    expect(result.commits[0]?.files_changed).toBeGreaterThanOrEqual(1);
    expect(result.commits[0]?.sha).toMatch(/^[0-9a-f]{7}$/);
  });

  it("respects max_count and branch filter", async () => {
    git(testDir, ["checkout", "-b", "feat/log"]);
    writeFileSync(join(testDir, "log.txt"), "log\n");
    git(testDir, ["add", "log.txt"]);
    git(testDir, ["commit", "-m", "feat: log branch"]);
    git(testDir, ["checkout", "main"]);

    const all = await runGitLog(testDir, { max_count: 1 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.commits).toHaveLength(1);

    const branchLog = await runGitLog(testDir, { branch: "feat/log", max_count: 5 });
    expect(branchLog.ok).toBe(true);
    if (!branchLog.ok) return;
    expect(branchLog.commits.some((c) => c.subject === "feat: log branch")).toBe(true);
  });

  it("filters by path", async () => {
    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(join(testDir, "src", "a.ts"), "a\n");
    git(testDir, ["add", "src/a.ts"]);
    git(testDir, ["commit", "-m", "feat: add a.ts"]);

    writeFileSync(join(testDir, "readme.md"), "hello\nv2\n");
    git(testDir, ["commit", "-am", "fix: update readme"]);

    const filtered = await runGitLog(testDir, { path: "src/a.ts", max_count: 10 });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.commits.some((c) => c.subject === "feat: add a.ts")).toBe(true);
    // The readme-only commit should not appear when filtered by src/a.ts
    expect(filtered.commits.every((c) => c.subject !== "fix: update readme")).toBe(true);
  });

  it("resolves path relative to session cwd, not repo root", async () => {
    const sub = join(testDir, "packages", "foo");
    mkdirSync(join(sub, "src"), { recursive: true });
    writeFileSync(join(sub, "src", "a.ts"), "export const a = 1;\n");
    git(testDir, ["add", "packages/foo/src/a.ts"]);
    git(testDir, ["commit", "-m", "chore: add package file"]);

    const log = await runGitLog(sub, { path: "src/a.ts", max_count: 10 });
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.commits.some((c) => c.subject === "chore: add package file")).toBe(true);
  });

  it("returns error for unknown branch", async () => {
    const result = await runGitLog(testDir, { branch: "does-not-exist" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not found/i);
  });

  it("returns not a git repository outside a repo", async () => {
    const empty = "/tmp/praana-test-git-tools-norepo-log";
    if (existsSync(empty)) rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    const result = await runGitLog(empty, {});
    expect(result).toEqual({ ok: false, error: "not a git repository" });
    rmSync(empty, { recursive: true, force: true });
  });

  it("handles since filter", async () => {
    const result = await runGitLog(testDir, { since: "1970-01-01", max_count: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commits.length).toBeGreaterThan(0);

    const future = await runGitLog(testDir, { since: "2099-01-01", max_count: 5 });
    expect(future.ok).toBe(true);
    if (!future.ok) return;
    expect(future.commits).toHaveLength(0);
  });
});

describe("resolveRepoPath", () => {
  it("rewrites cwd-relative paths against repo root", () => {
    const repoRoot = "/repo";
    const sessionCwd = "/repo/packages/foo";
    expect(resolveRepoPath(sessionCwd, repoRoot, "src/a.ts")).toEqual({
      ok: true,
      path: "packages/foo/src/a.ts",
    });
  });

  it("rejects paths outside the repository", () => {
    const result = resolveRepoPath("/repo/packages/foo", "/repo", "../../../outside");
    expect(result.ok).toBe(false);
  });
});
