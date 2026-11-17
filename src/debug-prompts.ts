// ============================================================
// PRAANA — debug-mode prompt and score artifacts
//
// In debug mode every turn writes the compiled prompt and, in engine mode,
// the compiler's score records into the session's `prompts/` directory
// (`~/.praana/sessions/<session_id>/prompts/`). Those files hold the whole
// assembled context window, so they are created owner-only like the session
// transcript: the directory from `APP_HOME_DIR_MODE` (0700) and the files
// 0600. The `mode` option on a create call only applies when the file is
// created, which is what is wanted here — an existing file keeps its mode
// (the app-home fix-up does not reach into session subdirectories).
// ============================================================
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { APP_HOME_DIR_MODE } from "./app-identity.js";

/** Mode for the compiled-prompt and score files (owner read/write only). */
export const DEBUG_PROMPT_FILE_MODE = 0o600;

/** Create the debug prompt directory owner-only when it does not exist yet. */
export function ensureDebugPromptDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: APP_HOME_DIR_MODE });
  return dir;
}

/** `turn-NNN.md` path for a 1-based turn number. */
export function debugPromptPath(dir: string, turnNum: number): string {
  return join(dir, `turn-${String(turnNum).padStart(3, "0")}.md`);
}

/** Write one compiled prompt owner-only and return the file path. */
export function saveDebugPrompt(
  dir: string,
  turnNum: number,
  prompt: string,
): string {
  ensureDebugPromptDir(dir);
  const file = debugPromptPath(dir, turnNum);
  writeFileSync(file, prompt, { encoding: "utf-8", mode: DEBUG_PROMPT_FILE_MODE });
  return file;
}

/** Append one JSON line per score record to `scores.jsonl`, owner-only on create. */
export function appendDebugScores(dir: string, records: readonly unknown[]): string {
  ensureDebugPromptDir(dir);
  const file = join(dir, "scores.jsonl");
  appendFileSync(
    file,
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    { mode: DEBUG_PROMPT_FILE_MODE },
  );
  return file;
}
