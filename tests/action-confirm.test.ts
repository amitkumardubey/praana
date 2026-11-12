/**
 * `edit_file` and `git_commit` confirmations (issue #748).
 *
 * Both tools used a `node:readline` prompt on `process.stdin`. In the TUI,
 * OpenTUI owns that stdin in raw mode with mouse tracking on, so the prompt
 * closed as declined before the answer arrived, answers leaked into the chat
 * box, and mouse reports landed in the input. They now go through the same
 * session confirmation path as risks: the installed UI handler (the overlay
 * yes/no), else `promptYesNo`, and a hard denial when headless.
 *
 * The tests drive the real `Session.confirmAction` and the real tool
 * factories, so the handler, the lock, the headless branch, and the tool
 * wiring are all covered. `node:readline` is spied globally: no tool may
 * create an interface for a confirmation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import * as readline from "node:readline";
import { loadConfig } from "../src/config.js";
import * as prompt from "../src/risk/prompt.js";
import { Session } from "../src/session.js";
import { createSystemTools } from "../src/tools/system.js";
import { createGitTools, runGitCommit, runGitStatus } from "../src/tools/git.js";
import { actionPreviewLines, writeActionConfirmPreview, type ActionConfirmRequest } from "../src/confirm/action.js";
import { capConfirmPreview, confirmPreviewRows } from "../src/ui/tui/overlays/confirm.js";
import { createOverlayUi } from "../src/ui/tui/overlays/state.js";
import { setUiWriters } from "../src/ui.js";
import { readFileSync as readSource } from "node:fs";
import { fileURLToPath } from "node:url";

const hasGit = (() => {
  const r = spawnSync("git", ["--version"], { stdio: "ignore" });
  return r.status === 0;
})();

const cleanups: Array<() => void> = [];

function makeSession(headless = false): Session {
  const dir = mkdtempSync(join(tmpdir(), "praana-action-confirm-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig();
  config.session.log_dir = join(dir, "sessions");
  const session = Session.createNew("test-session", dir, config);
  session.headless = headless;
  return session;
}

/** The tool-level confirm callback `turn.ts` supplies from the session. */
function confirmCallbackOf(session: Session) {
  return (request: ActionConfirmRequest) => session.confirmAction(request);
}

function systemToolsWith(session: Session, cwd: string, editConfirm = true) {
  return createSystemTools({
    cwd,
    editConfirm,
    confirmAction: confirmCallbackOf(session),
  });
}

function gitToolsWith(session: Session, cwd: string, editConfirm = true) {
  return createGitTools({
    cwd,
    editConfirm,
    confirmAction: confirmCallbackOf(session),
  });
}

function makeWorkDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "praana-action-confirm-cwd-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, args: string[]): void {
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
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function setupRepo(): string {
  const dir = makeWorkDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@praana.local"]);
  git(dir, ["config", "user.name", "Praana Test"]);
  writeFileSync(join(dir, "readme.md"), "hello\n");
  git(dir, ["add", "readme.md"]);
  git(dir, ["commit", "-m", "chore: initial"]);
  return dir;
}

function commitCount(cwd: string): number {
  const r = spawnSync("git", ["rev-list", "--count", "HEAD"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) throw new Error(`git rev-list failed: ${r.stderr}`);
  return Number(r.stdout.trim());
}

afterAll(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

beforeEach(() => {
  // Any readline here is the bug; keep tool output off the test's stderr.
  setUiWriters({ stderr: () => {} });
});

afterEach(() => {
  setUiWriters();
});

describe("action preview sanitization", () => {
  it("keeps both ends at the hard preview bound", () => {
    const preview = Array.from({ length: 500 }, (_, i) => ({ text: `line ${i}`, tone: "plain" as const }));
    const lines = actionPreviewLines({ question: "?", preview });
    expect(lines).toHaveLength(400);
    expect(lines[0]).toBe("line 0");
    expect(lines.at(-1)).toBe("line 499");
    expect(lines.filter((line) => line.includes("more lines"))).toHaveLength(1);
  });
  it("replaces each unsafe invisible and bidi character", () => {
    const ranges = [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x00ad, 0x00ad],
      [0x061c, 0x061c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e],
      [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
    for (const [start, end] of ranges) {
      for (let code = start!; code <= end!; code++) {
        const text = `a${String.fromCodePoint(code)}b`;
        expect(actionPreviewLines({ question: "?", preview: [{ text, tone: "plain" }] })).toEqual(["a·b"]);
      }
    }
  });

  it("distinguishes CRLF from LF in edit rows", () => {
    const preview: ActionConfirmRequest["preview"] = [
      ..."foo\r\nbar".split("\n").map((text) => ({ text: `- ${text}`, tone: "remove" as const })),
      ..."foo\nbar".split("\n").map((text) => ({ text: `+ ${text}`, tone: "add" as const })),
    ];
    expect(actionPreviewLines({ question: "?", preview })).toEqual(["- foo␍", "- bar", "+ foo", "+ bar"]);
  });

  it("preserves tabs and marks CRLF while replacing unsafe controls only in the overlay", () => {
    const request: ActionConfirmRequest = { question: "?", preview: [{ text: "\tindent\r\nplain\r\n\u001b[31m\u202Eevil\u200b\u2028\ufeff", tone: "plain" }] };
    const lines = actionPreviewLines(request);
    expect(lines).toEqual(["\tindent␍", "plain␍", "·[31m·evil···"]);
    const chunks: string[] = [];
    setUiWriters({ stderr: (line) => chunks.push(line) });
    writeActionConfirmPreview(request);
    expect(chunks.join("")).toContain(request.preview[0]!.text);
  });
});

describe("edit_file confirmation", () => {
  it("asks the installed handler, never readline, and applies on yes", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    writeFileSync(join(cwd, "confirm.txt"), "Hello World\n");
    const prompts: string[] = [];
    session.setConfirmHandler(async (message) => {
      prompts.push(message);
      return true;
    });
    const createInterface = spyOn(readline, "createInterface");
    try {
      const result = await systemToolsWith(session, cwd).edit_file.execute({
        path: "confirm.txt",
        oldText: "World",
        newText: "PRAANA",
      });
      expect(result).toEqual({ ok: true });
      expect(readFileSync(join(cwd, "confirm.txt"), "utf-8")).toBe("Hello PRAANA\n");
      expect(prompts).toHaveLength(1);
      expect(createInterface).not.toHaveBeenCalled();
    } finally {
      createInterface.mockRestore();
    }
  });

  it("puts the diff preview in the structured preview passed to the handler", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    writeFileSync(join(cwd, "preview.txt"), "line1\nline2\nHello World\n");
    const prompts: string[] = [];
    const previews: string[] = [];
    session.setConfirmHandler(async (message, options) => {
      prompts.push(message);
      previews.push((options?.preview ?? []).join("\n"));
      return true;
    });
    await systemToolsWith(session, cwd).edit_file.execute({
      path: "preview.txt",
      oldText: "World",
      newText: "PRAANA",
    });
    // The question is only the question; the preview travels beside it.
    expect(prompts[0]).toBe("Apply edit? [y/N]");
    const preview = previews[0] ?? "";
    expect(preview).toContain("preview.txt:3");
    expect(preview).toContain("- World");
    expect(preview).toContain("+ PRAANA");
    // Plain text: the overlay renders the preview itself, so chalk ANSI
    // escapes must not reach it.
    expect(preview).not.toMatch(/\u001b\[/);
  });

  it("sanitizes control characters in the preview sent to the overlay", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    writeFileSync(join(cwd, "control.txt"), "old\r\u001b[31m");
    let preview: readonly string[] = [];
    session.setConfirmHandler(async (_prompt, options) => {
      preview = options?.preview ?? [];
      return false;
    });
    await systemToolsWith(session, cwd).edit_file.execute({
      path: "control.txt", oldText: "old\r\u001b[31m", newText: "new\u009b",
    });
    expect(preview.join("\n")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(preview.join("\n")).toContain("old··[31m");
  });

  it("passes the whole preview for the overlay to cap", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    const oldLines = Array.from({ length: 60 }, (_, i) => `old ${i}`);
    const newLines = Array.from({ length: 60 }, (_, i) => `new ${i}`);
    writeFileSync(join(cwd, "big.txt"), `${oldLines.join("\n")}\n`);
    let preview: readonly string[] = [];
    session.setConfirmHandler(async (_message, options) => {
      preview = options?.preview ?? [];
      return false;
    });
    await systemToolsWith(session, cwd).edit_file.execute({
      path: "big.txt",
      oldText: oldLines.join("\n"),
      newText: newLines.join("\n"),
    });
    expect(preview).toHaveLength(122);
    expect(preview).toContain("- old 59");
    expect(preview).toContain("+ new 59");
    expect(preview.filter((line) => line.includes("more lines"))).toHaveLength(0);
    const tall = capConfirmPreview(preview, confirmPreviewRows(60, 1, true));
    expect(tall).toContain("- old 0");
    expect(tall).toContain("+ new 59");
    expect(tall.filter((line) => line.includes("more lines"))).toHaveLength(1);
  });

  it("keeps the classic edit preview complete", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    const lines = Array.from({ length: 40 }, (_, i) => `old ${i}`);
    writeFileSync(join(cwd, "classic-big.txt"), lines.join("\n"));
    const chunks: string[] = [];
    setUiWriters({ stderr: (line) => chunks.push(line) });
    const promptSpy = spyOn(prompt, "promptYesNo").mockResolvedValue(false);
    try {
      await systemToolsWith(session, cwd).edit_file.execute({ path: "classic-big.txt", oldText: lines.join("\n"), newText: "new" });
      expect(chunks.join("\n")).toContain("- old 39");
      expect(chunks.join("\n")).not.toContain("more lines");
    } finally {
      promptSpy.mockRestore();
    }
  });

  it("does not overwrite a file changed while awaiting confirmation", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    const file = join(cwd, "race.txt");
    writeFileSync(file, "original");
    session.setConfirmHandler(async () => {
      writeFileSync(file, "changed externally");
      return true;
    });
    const result = await systemToolsWith(session, cwd).edit_file.execute({
      path: "race.txt", oldText: "original", newText: "replacement",
    });
    expect(result).toEqual({ ok: false, error: "File changed while waiting for confirmation; nothing was written" });
    expect(readFileSync(file, "utf-8")).toBe("changed externally");
  });

  it("returns the cancelled error and leaves the bytes untouched on no", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    writeFileSync(join(cwd, "confirm.txt"), "Hello World\n");
    session.setConfirmHandler(async () => false);
    const result = await systemToolsWith(session, cwd).edit_file.execute({
      path: "confirm.txt",
      oldText: "World",
      newText: "PRAANA",
    });
    expect(result).toEqual({ ok: false, error: "Edit cancelled by user" });
    expect(readFileSync(join(cwd, "confirm.txt"), "utf-8")).toBe("Hello World\n");
  });

  it("denies with a clear error when the session is headless", async () => {
    const session = makeSession(true);
    const cwd = makeWorkDir();
    writeFileSync(join(cwd, "confirm.txt"), "Hello World\n");
    let calls = 0;
    session.setConfirmHandler(async () => {
      calls += 1;
      return true;
    });
    const promptSpy = spyOn(prompt, "promptYesNo");
    try {
      const result = await systemToolsWith(session, cwd).edit_file.execute({
        path: "confirm.txt",
        oldText: "World",
        newText: "PRAANA",
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("confirmation required");
      expect(result.error).toContain("headless");
      expect(readFileSync(join(cwd, "confirm.txt"), "utf-8")).toBe("Hello World\n");
      expect(calls).toBe(0);
      expect(promptSpy).not.toHaveBeenCalled();
    } finally {
      promptSpy.mockRestore();
    }
  });

  it("does not ask at all when edit.confirm is false", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    writeFileSync(join(cwd, "confirm.txt"), "Hello World\n");
    let calls = 0;
    session.setConfirmHandler(async () => {
      calls += 1;
      return false;
    });
    const result = await systemToolsWith(session, cwd, false).edit_file.execute({
      path: "confirm.txt",
      oldText: "World",
      newText: "PRAANA",
    });
    expect(result).toEqual({ ok: true });
    expect(readFileSync(join(cwd, "confirm.txt"), "utf-8")).toBe("Hello PRAANA\n");
    expect(calls).toBe(0);
  });

  it("still uses promptYesNo and the stderr preview without a handler", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    writeFileSync(join(cwd, "classic.txt"), "line1\nHello World\n");
    const chunks: string[] = [];
    setUiWriters({ stderr: (line) => chunks.push(line) });
    const promptSpy = spyOn(prompt, "promptYesNo").mockResolvedValue(true);
    try {
      const result = await systemToolsWith(session, cwd).edit_file.execute({
        path: "classic.txt",
        oldText: "World",
        newText: "PRAANA",
      });
      expect(result).toEqual({ ok: true });
      expect(promptSpy).toHaveBeenCalledTimes(1);
      // The classic prompt asks the short question: the preview goes to stderr
      // instead of into the prompt, exactly once.
      const asked = promptSpy.mock.calls[0]?.[0] ?? "";
      expect(asked).toContain("Apply edit?");
      expect(asked).not.toContain("classic.txt:2");
      const stderr = chunks.join("");
      expect(stderr).toContain("classic.txt:2");
      expect(stderr.split("classic.txt:2")).toHaveLength(3);
      expect(readFileSync(join(cwd, "classic.txt"), "utf-8")).toBe("line1\nHello PRAANA\n");
    } finally {
      promptSpy.mockRestore();
    }
  });
});

describe("git_commit confirmation", () => {
  it("describes session confirmation and headless refusal", () => {
    const description = createGitTools({ cwd: process.cwd() }).git_commit.description ?? "";
    expect(description).toContain("session");
    expect(description).toContain("headless");
    expect(description).toContain("refuses");
  });

  it("asks the installed handler, never readline, and commits on yes", async () => {
    if (!hasGit) return;
    const session = makeSession();
    const cwd = setupRepo();
    writeFileSync(join(cwd, "readme.md"), "hello again\n");
    const prompts: string[] = [];
    session.setConfirmHandler(async (message, options) => {
      prompts.push([message, ...(options?.preview ?? [])].join("\n"));
      return true;
    });
    const createInterface = spyOn(readline, "createInterface");
    try {
      const result = await gitToolsWith(session, cwd).git_commit.execute({
        message: "fix: update readme",
        all: true,
      });
      expect(result.ok).toBe(true);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("fix: update readme");
      expect(prompts[0]).toContain("Create commit?");
      expect(createInterface).not.toHaveBeenCalled();
      expect(commitCount(cwd)).toBe(2);
    } finally {
      createInterface.mockRestore();
    }
  });

  it("puts the commit stat preview in the structured preview passed to the handler", async () => {
    if (!hasGit) return;
    const session = makeSession();
    const cwd = setupRepo();
    writeFileSync(join(cwd, "readme.md"), "hello again\nmore\n");
    const prompts: string[] = [];
    const previews: string[] = [];
    session.setConfirmHandler(async (message, options) => {
      prompts.push(message);
      previews.push((options?.preview ?? []).join("\n"));
      return false;
    });
    await gitToolsWith(session, cwd).git_commit.execute({
      message: "fix: staged preview",
      paths: ["readme.md"],
    });
    expect(prompts[0]).toBe("Create commit? [y/N]");
    const preview = previews[0] ?? "";
    expect(preview).toContain("fix: staged preview");
    expect(preview).toContain("readme.md");
    expect(preview).not.toMatch(/\u001b\[/);
  });

  it("keeps the commit stat summary through the overlay cap", async () => {
    if (!hasGit) return;
    const session = makeSession();
    const cwd = setupRepo();
    for (let i = 0; i < 20; i++) writeFileSync(join(cwd, `file-${i}.txt`), "change\n");
    git(cwd, ["add", "."]);
    let preview: readonly string[] = [];
    session.setConfirmHandler(async (_message, options) => { preview = options?.preview ?? []; return false; });
    await gitToolsWith(session, cwd).git_commit.execute({ message: Array.from({ length: 30 }, (_, i) => `message ${i}`).join("\n") });
    const visible = capConfirmPreview(preview, confirmPreviewRows(24, 1, true));
    expect(visible.some((line) => line.includes("20 files changed"))).toBe(true);
    expect(visible.filter((line) => line.includes("more lines"))).toHaveLength(1);
  });

  it("returns the cancelled error and leaves the index and HEAD untouched on no", async () => {
    if (!hasGit) return;
    const session = makeSession();
    const cwd = setupRepo();
    writeFileSync(join(cwd, "readme.md"), "hello again\n");
    session.setConfirmHandler(async () => false);
    const before = commitCount(cwd);
    const result = await gitToolsWith(session, cwd).git_commit.execute({
      message: "feat: should cancel",
      paths: ["readme.md"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Commit cancelled by user");
    expect(commitCount(cwd)).toBe(before);
    const status = await runGitStatus(cwd);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.staged.some((e) => e.path === "readme.md")).toBe(false);
    expect(status.unstaged.some((e) => e.path === "readme.md")).toBe(true);
  });

  it("denies with a clear error when the session is headless", async () => {
    if (!hasGit) return;
    const session = makeSession(true);
    const cwd = setupRepo();
    writeFileSync(join(cwd, "readme.md"), "hello again\n");
    const before = commitCount(cwd);
    const result = await gitToolsWith(session, cwd).git_commit.execute({
      message: "feat: headless",
      all: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("confirmation required");
    expect(result.error).toContain("headless");
    expect(commitCount(cwd)).toBe(before);
  });

  it("does not ask at all when edit.confirm is false", async () => {
    if (!hasGit) return;
    const session = makeSession();
    const cwd = setupRepo();
    writeFileSync(join(cwd, "readme.md"), "hello again\n");
    let calls = 0;
    session.setConfirmHandler(async () => {
      calls += 1;
      return false;
    });
    const result = await createGitTools({ cwd }).git_commit.execute({
      message: "chore: no confirm",
      all: true,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
    expect(commitCount(cwd)).toBe(2);
  });

  it("still uses promptYesNo without a handler", async () => {
    if (!hasGit) return;
    const session = makeSession();
    const cwd = setupRepo();
    writeFileSync(join(cwd, "readme.md"), "hello again\n");
    const promptSpy = spyOn(prompt, "promptYesNo").mockResolvedValue(false);
    try {
      const result = await runGitCommit(
        cwd,
        { message: "chore: classic", all: true },
        { editConfirm: true, confirmAction: confirmCallbackOf(session) },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe("Commit cancelled by user");
      expect(promptSpy).toHaveBeenCalledTimes(1);
      expect(promptSpy.mock.calls[0]?.[0]).toContain("Create commit?");
    } finally {
      promptSpy.mockRestore();
    }
  });
});

describe("no tool reads stdin for a confirmation", () => {
  it("neither system.ts nor git.ts creates a readline interface", () => {
    for (const rel of ["../src/tools/system.ts", "../src/tools/git.ts"]) {
      const src = readSource(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src).not.toContain("createInterface");
      expect(src).not.toContain("node:readline");
    }
  });
});

describe("parallel edit_file confirmations", () => {
  it("asks once per file, one after the other, and applies both", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    writeFileSync(join(cwd, "a.txt"), "alpha\n");
    writeFileSync(join(cwd, "b.txt"), "beta\n");
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    // The overlay draws one confirm at a time; the session lock must hold the
    // second caller back rather than let both prompts race on screen.
    session.setConfirmHandler(async (message) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(message.includes("a.txt") ? "a" : "b");
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return true;
    });
    const tools = systemToolsWith(session, cwd);
    const [a, b] = await Promise.all([
      tools.edit_file.execute({ path: "a.txt", oldText: "alpha", newText: "ALPHA" }),
      tools.edit_file.execute({ path: "b.txt", oldText: "beta", newText: "BETA" }),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(order).toHaveLength(2);
    expect(maxInFlight).toBe(1);
    expect(readFileSync(join(cwd, "a.txt"), "utf-8")).toBe("ALPHA\n");
    expect(readFileSync(join(cwd, "b.txt"), "utf-8")).toBe("BETA\n");
  });
});

describe("aborted turn", () => {
  it("settles a pending edit confirmation as declined and leaves the file alone", async () => {
    const session = makeSession();
    const cwd = makeWorkDir();
    writeFileSync(join(cwd, "abort.txt"), "Hello World\n");
    // Same shape as `askRiskFromOverlay` in run.tsx: the overlay confirm takes
    // the turn signal, so Ctrl+C settles it false instead of leaving it up.
    const turnAbort = new AbortController();
    const overlay = createOverlayUi();
    session.setConfirmHandler(async (message) => {
      if (turnAbort.signal.aborted) return false;
      const yes = await overlay.showConfirm(message, turnAbort.signal, { mode: "yesno" });
      return yes && !turnAbort.signal.aborted;
    });
    try {
      const pending = systemToolsWith(session, cwd).edit_file.execute({
        path: "abort.txt",
        oldText: "World",
        newText: "PRAANA",
      });
      // Let the tool reach the prompt, then abort the turn the way Ctrl+C does.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(overlay.confirmPrompt()).not.toBeNull();
      turnAbort.abort();
      const result = await pending;
      expect(result).toEqual({ ok: false, error: "Edit cancelled by user" });
      expect(readFileSync(join(cwd, "abort.txt"), "utf-8")).toBe("Hello World\n");
      expect(overlay.confirmPrompt()).toBeNull();
    } finally {
      overlay.dispose();
    }
  });
});
