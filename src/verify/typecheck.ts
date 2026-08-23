/**
 * Scoped tsc --noEmit for post-edit verification (#299).
 */

import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { pathInRoot } from "../lsp/workspace-roots.js";
import { commandOnPath, spawnTimed } from "./spawn.js";
import {
  VERIFY_TSC_CAP,
  type TypecheckError,
  type TypecheckResult,
} from "./types.js";

const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);

const ERROR_LINE =
  /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

export interface TypecheckSpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type RunTypecheckFn = (
  projectDir: string,
  timeoutMs: number,
) => Promise<TypecheckSpawnResult>;

export function parseTscOutput(text: string): TypecheckError[] {
  const errors: TypecheckError[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(ERROR_LINE);
    if (!match) continue;
    const [, file, lineNo, col, code, message] = match;
    errors.push({
      file: file ?? "",
      line: Number(lineNo),
      col: Number(col),
      message: `${code}: ${message?.trim() ?? ""}`,
    });
    if (errors.length >= VERIFY_TSC_CAP) break;
  }
  return errors;
}

export function findTsconfigDir(
  absPath: string,
  sessionRoot: string,
): string | null {
  let dir = dirname(absPath);
  const root = sessionRoot.replace(/\/+$/, "") || sessionRoot;
  while (pathInRoot(dir, root) || dir === root) {
    if (existsSync(join(dir, "tsconfig.json"))) return dir;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export async function checkTypecheck(
  absPath: string,
  sessionRoot: string,
  opts: {
    runTypecheck?: RunTypecheckFn;
    timeoutMs?: number;
  } = {},
): Promise<TypecheckResult> {
  const ext = extname(absPath).toLowerCase();
  if (!TS_EXT.has(ext)) {
    return { errors: [], skipped: "unsupported" };
  }
  const projectDir = findTsconfigDir(absPath, sessionRoot);
  if (!projectDir) {
    return { errors: [], skipped: "no_tsconfig" };
  }
  const run = opts.runTypecheck;
  if (!run) {
    return { errors: [], skipped: "no_runner" };
  }
  try {
    const spawned = await run(projectDir, opts.timeoutMs ?? 30_000);
    const errors = parseTscOutput(`${spawned.stderr}\n${spawned.stdout}`);
    if (errors.length === 0 && spawned.code !== 0 && spawned.code !== null) {
      return { errors: [], skipped: "unparsed" };
    }
    return { errors };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/timed? ?out/i.test(msg)) {
      return { errors: [], skipped: "timeout" };
    }
    return { errors: [], skipped: "spawn_error" };
  }
}

export function typecheckHasErrors(result: TypecheckResult): boolean {
  return result.errors.length > 0;
}

export async function defaultRunTypecheck(
  projectDir: string,
  timeoutMs: number,
): Promise<TypecheckSpawnResult> {
  if (commandOnPath("bun")) {
    return spawnTimed("bun", ["x", "tsc", "--noEmit", "--pretty", "false", "-p", projectDir], {
      timeoutMs,
      cwd: projectDir,
    });
  }
  if (commandOnPath("npx")) {
    return spawnTimed("npx", ["tsc", "--noEmit", "--pretty", "false", "-p", projectDir], {
      timeoutMs,
      cwd: projectDir,
    });
  }
  throw new Error("no_runner");
}
