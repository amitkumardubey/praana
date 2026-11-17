/**
 * Debug prompt artifacts are private to the user (issue #804).
 *
 * In debug mode every turn writes the compiled prompt — the whole assembled
 * context window — into `~/.praana/sessions/<session_id>/prompts/`, and in
 * engine mode appends compiler score records to `scores.jsonl` next to it.
 * Both used to land with the default umask (`0755` directory, `0644` files),
 * so any local user on a shared machine could read them. This pins the
 * owner-only modes.
 *
 * The writes live in `src/debug-prompts.ts` (`src/turn.ts` is safety-pinned);
 * every path here comes from a temp dir, never from the real home.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendDebugScores,
  DEBUG_PROMPT_FILE_MODE,
  debugPromptPath,
  ensureDebugPromptDir,
  saveDebugPrompt,
} from "../src/debug-prompts.js";
import { APP_HOME_DIR_MODE } from "../src/app-identity.js";
import { isWindows } from "./helpers/platform.js";

/** Permission bits (lowest 9) of a path. */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe("debug prompt artifacts", () => {
  let root: string | null = null;

  /** Fresh temp dir standing in for the session directory. */
  function promptDir(): string {
    root = mkdtempSync(join(tmpdir(), "praana-debug-prompts-test-"));
    return join(root, "prompts");
  }

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = null;
    }
  });

  it("names prompt files by zero-padded turn number", () => {
    expect(debugPromptPath("/tmp/prompts", 1)).toBe("/tmp/prompts/turn-001.md");
    expect(debugPromptPath("/tmp/prompts", 42)).toBe("/tmp/prompts/turn-042.md");
    expect(debugPromptPath("/tmp/prompts", 1234)).toBe("/tmp/prompts/turn-1234.md");
  });

  it("only creates the directory when it is missing", () => {
    const dir = ensureDebugPromptDir(promptDir());
    expect(existsSync(dir)).toBe(true);

    // A second call is a no-op, not an error.
    expect(() => ensureDebugPromptDir(dir)).not.toThrow();
  });

  it.skipIf(isWindows)("creates the prompt directory 0700 and the prompt 0600", () => {
    const dir = promptDir();
    const previous = process.umask(0o000);
    let written: string;
    try {
      written = saveDebugPrompt(dir, 1, "# compiled prompt\nsecret context\n");
    } finally {
      process.umask(previous);
    }

    expect(written).toBe(join(dir, "turn-001.md"));
    expect(modeOf(dir)).toBe(APP_HOME_DIR_MODE);
    expect(modeOf(written)).toBe(DEBUG_PROMPT_FILE_MODE);
    expect(DEBUG_PROMPT_FILE_MODE).toBe(0o600);
    expect(readFileSync(written, "utf-8")).toBe("# compiled prompt\nsecret context\n");
  });

  it.skipIf(isWindows)("creates scores.jsonl 0600 and keeps appending to it", () => {
    const dir = promptDir();
    const previous = process.umask(0o000);
    try {
      appendDebugScores(dir, [{ unit: "u1", score: 1 }]);
      appendDebugScores(dir, [{ unit: "u2", score: 2 }]);
    } finally {
      process.umask(previous);
    }

    const scores = join(dir, "scores.jsonl");
    expect(modeOf(dir)).toBe(APP_HOME_DIR_MODE);
    expect(modeOf(scores)).toBe(0o600);
    // One JSON object per line, appended rather than rewritten.
    expect(readFileSync(scores, "utf-8")).toBe(
      '{"unit":"u1","score":1}\n{"unit":"u2","score":2}\n',
    );
  });

  it.skipIf(isWindows)("writes both artifacts private under the default umask", () => {
    const dir = promptDir();
    const prompt = saveDebugPrompt(dir, 7, "prompt");
    appendDebugScores(dir, [{ unit: "u1" }]);

    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(prompt)).toBe(0o600);
    expect(modeOf(join(dir, "scores.jsonl"))).toBe(0o600);
  });
});
