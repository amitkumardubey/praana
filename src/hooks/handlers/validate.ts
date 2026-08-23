/**
 * Tool-call pre-validation and error enrichment (issue #300).
 *
 * Registered after plan-mode and before write-path acquire.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { commandOnPath as defaultCommandOnPath } from "../../verify/spawn.js";
import { suggestPaths } from "../../validate/fuzzy-path.js";
import { checkShellCommand } from "../../validate/shell-check.js";
import type { PostToolCallHandler, PreToolCallHandler } from "../types.js";

const SUGGEST_CAP = 5;

const ENRICH_TOOLS = new Set([
  "read_file",
  "edit_file",
  "write_file",
  "search_code",
  "find_files",
]);

export interface ValidateHookOptions {
  cwd: string;
  pathExists?: (absPath: string) => boolean;
  listRepoFiles?: () => string[];
  commandOnPath?: (name: string) => boolean;
}

function resolvePath(cwd: string, relPath: string): string {
  return isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
}

function defaultListRepoFiles(cwd: string): string[] {
  try {
    const spawned = spawnSync("git", ["ls-files", "-z"], {
      cwd,
      encoding: "buffer",
    });
    if (spawned.status !== 0 || !spawned.stdout) return [];
    return spawned.stdout
      .toString("utf-8")
      .split("\0")
      .filter(Boolean)
      .map((rel) => resolvePath(cwd, rel));
  } catch {
    return [];
  }
}

function collectCandidates(
  opts: ValidateHookOptions,
  listReadPaths?: () => string[],
): string[] {
  let repo: string[] = [];
  try {
    repo = (opts.listRepoFiles ?? (() => defaultListRepoFiles(opts.cwd)))();
  } catch {
    repo = [];
  }
  const reads = listReadPaths?.() ?? [];
  return [...repo, ...reads];
}

function missingPathBlock(
  rel: string,
  abs: string,
  opts: ValidateHookOptions,
  listReadPaths?: () => string[],
): {
  action: "block";
  error: string;
  isError: true;
  suggestions?: string[];
} {
  let suggestions: string[] | undefined;
  try {
    const found = suggestPaths(
      rel,
      collectCandidates(opts, listReadPaths),
      SUGGEST_CAP,
      opts.cwd,
    );
    if (found.length > 0) suggestions = found;
  } catch {
    suggestions = undefined;
  }
  return {
    action: "block",
    error: `Path does not exist: ${rel} (${abs})`,
    isError: true,
    ...(suggestions ? { suggestions } : {}),
  };
}

export function createValidateHandlers(opts: ValidateHookOptions): {
  pre: PreToolCallHandler;
  post: PostToolCallHandler;
} {
  const pathExists = opts.pathExists ?? existsSync;
  const onPath = opts.commandOnPath ?? defaultCommandOnPath;

  const pre: PreToolCallHandler = (ctx) => {
    if (ctx.toolName === "read_file" && typeof ctx.args.path === "string") {
      const abs = resolvePath(opts.cwd, ctx.args.path);
      if (!pathExists(abs)) {
        return missingPathBlock(
          ctx.args.path,
          abs,
          opts,
          ctx.session.listReadPaths,
        );
      }
      return;
    }

    if (ctx.toolName === "edit_file" && typeof ctx.args.path === "string") {
      const abs = resolvePath(opts.cwd, ctx.args.path);
      if (!pathExists(abs)) {
        return missingPathBlock(
          ctx.args.path,
          abs,
          opts,
          ctx.session.listReadPaths,
        );
      }
      const read = ctx.session.hasReadPath?.(abs);
      if (read === false) {
        return {
          action: "block",
          error: `Read the file first before edit_file: ${ctx.args.path}`,
          isError: true,
        };
      }
      return;
    }

    if (ctx.toolName === "shell" && typeof ctx.args.command === "string") {
      const cwdArg =
        typeof ctx.args.cwd === "string" && ctx.args.cwd.length > 0
          ? resolvePath(opts.cwd, ctx.args.cwd)
          : undefined;
      const err = checkShellCommand(ctx.args.command, {
        cwd: cwdArg,
        pathExists,
        commandOnPath: onPath,
      });
      if (err) {
        return { action: "block", error: err, isError: true };
      }
    }
  };

  const post: PostToolCallHandler = (ctx) => {
    if (!ctx.isError || !ctx.result || typeof ctx.result !== "object") return;
    const result = ctx.result as Record<string, unknown>;
    if (result.ok !== false) return;

    const enrich =
      ENRICH_TOOLS.has(ctx.toolName) || ctx.toolName.startsWith("lsp_");
    if (!enrich) return;

    const rel = pathFromArgs(ctx.args);
    if (!rel) return;
    const abs = resolvePath(opts.cwd, rel);

    let suggestions: string[] | undefined;
    try {
      const found = suggestPaths(
        rel,
        collectCandidates(opts, ctx.session.listReadPaths),
        SUGGEST_CAP,
        opts.cwd,
      );
      if (found.length > 0) suggestions = found;
    } catch {
      suggestions = undefined;
    }

    let recent_writes: Array<{ path: string; turn?: number }> | undefined;
    try {
      const writes = ctx.session.recentWritesForPath?.(abs) ?? [];
      if (writes.length > 0) recent_writes = writes;
    } catch {
      recent_writes = undefined;
    }

    if (!suggestions && !recent_writes) return;
    return {
      result: {
        ...result,
        ...(suggestions ? { suggestions } : {}),
        ...(recent_writes ? { recent_writes } : {}),
      },
    };
  };

  return { pre, post };
}

function pathFromArgs(args: Record<string, unknown>): string | null {
  if (typeof args.path === "string") return args.path;
  if (Array.isArray(args.files)) {
    for (const file of args.files) {
      if (
        file &&
        typeof file === "object" &&
        typeof (file as { path?: unknown }).path === "string"
      ) {
        return (file as { path: string }).path;
      }
    }
  }
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (
        edit &&
        typeof edit === "object" &&
        typeof (edit as { path?: unknown }).path === "string"
      ) {
        return (edit as { path: string }).path;
      }
    }
  }
  return null;
}
