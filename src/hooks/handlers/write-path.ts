import { isAbsolute, resolve } from "node:path";
import type { PostToolCallHandler, PreToolCallHandler } from "../types.js";

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "batch_write",
  "batch_edit",
]);

export class WritePathGuard {
  private readonly pending = new Set<string>();

  constructor(private readonly cwd: string) {}

  resolvePath(relPath: string): string {
    return isAbsolute(relPath) ? relPath : resolve(this.cwd, relPath);
  }

  has(absPath: string): boolean {
    return this.pending.has(absPath);
  }

  tryAcquire(
    absPath: string,
    relPath: string,
  ): { ok: true } | { ok: false; error: string } {
    if (this.pending.has(absPath)) {
      return {
        ok: false,
        error: `Concurrent write already in progress for ${relPath}. Avoid parallel mutating tool calls targeting the same path.`,
      };
    }
    this.pending.add(absPath);
    return { ok: true };
  }

  release(absPath: string): void {
    this.pending.delete(absPath);
  }
}

function relPathsFromArgs(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "read_file"
  ) {
    return typeof args.path === "string" ? [args.path] : [];
  }
  if (toolName === "batch_write" && Array.isArray(args.files)) {
    return args.files.flatMap((file) =>
      file && typeof file === "object" && typeof (file as { path?: unknown }).path === "string"
        ? [(file as { path: string }).path]
        : [],
    );
  }
  if (toolName === "batch_edit" && Array.isArray(args.edits)) {
    return args.edits.flatMap((edit) =>
      edit && typeof edit === "object" && typeof (edit as { path?: unknown }).path === "string"
        ? [(edit as { path: string }).path]
        : [],
    );
  }
  return [];
}

export function createWritePathPreToolCallHandler(
  guard: WritePathGuard,
): PreToolCallHandler {
  return (ctx) => {
    if (ctx.toolName === "read_file") {
      const relPath = typeof ctx.args.path === "string" ? ctx.args.path : null;
      if (!relPath) return;
      if (guard.has(guard.resolvePath(relPath))) {
        return {
          action: "block",
          isError: false,
          error: `A write to ${relPath} is currently in progress. Avoid concurrent read_file and write_file/edit_file/batch_write/batch_edit calls targeting the same path.`,
        };
      }
      return;
    }

    if (!WRITE_TOOLS.has(ctx.toolName)) return;

    const acquired: string[] = [];
    for (const relPath of relPathsFromArgs(ctx.toolName, ctx.args)) {
      const absPath = guard.resolvePath(relPath);
      if (acquired.includes(absPath)) continue;
      const result = guard.tryAcquire(absPath, relPath);
      if (!result.ok) {
        for (const held of acquired) guard.release(held);
        return { action: "block", isError: false, error: result.error };
      }
      acquired.push(absPath);
    }
  };
}

export function createWritePathPostToolCallHandler(
  guard: WritePathGuard,
): PostToolCallHandler {
  return (ctx) => {
    if (!WRITE_TOOLS.has(ctx.toolName)) return;
    const seen = new Set<string>();
    for (const relPath of relPathsFromArgs(ctx.toolName, ctx.args)) {
      const absPath = guard.resolvePath(relPath);
      if (seen.has(absPath)) continue;
      seen.add(absPath);
      guard.release(absPath);
    }
  };
}
