import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { resolve as resolvePath, isAbsolute, join } from "node:path";
import type { SandboxConfig } from "../types.js";
import {
  buildFffQuery,
  pathToConstraint,
  sandboxBlockReason,
  getFffManager,
  getFffLoadError,
  clearFffCache,
} from "../fff.js";

export interface FindFilesMatch {
  file: string;
  relative_path: string;
  name: string;
  size: number;
  modified: number;
  git_status: string;
}

export interface FindFilesStats {
  totalMatches: number;
  truncated: boolean;
  dropped: number;
}

export interface FindFilesSuccess {
  ok: true;
  pattern: string;
  path: string;
  matches: FindFilesMatch[];
  stats: FindFilesStats;
  duration_ms: number;
}

export interface FindFilesError {
  ok: false;
  error: string;
}

export type FindFilesResult = FindFilesSuccess | FindFilesError;

export interface FindFilesToolContext {
  cwd: string;
  getAbortSignal?: () => AbortSignal | undefined;
  sandbox?: SandboxConfig;
  scanTimeoutMs?: number;
}

const findFilesSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("Fuzzy file path pattern (e.g. 'comp butt', 'src/main.ts')"),
  mode: z
    .enum(["fuzzy", "glob"])
    .optional()
    .describe("Search mode: fuzzy (default, typo-resistant) or glob (pure glob filter)"),
  path: z
    .string()
    .optional()
    .describe("Directory to scope search (base-relative constraint)"),
  max_results: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Maximum files to return (default 50)"),
  timeout: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Timeout in milliseconds (default 5000)"),
});

export type FindFilesArgs = z.infer<typeof findFilesSchema>;

export function buildFindFilesQuery(args: FindFilesArgs, cwd: string, searchPath: string): string {
  // For find_files, path constraint is the directory scope.
  // In glob mode, pattern itself is a glob; path is extra constraint.
  const constraints: string[] = [];
  if (args.path) {
    const c = pathToConstraint(cwd, searchPath);
    if (c) constraints.push(c);
  }
  if (constraints.length === 0) return args.pattern;
  // fff's fileSearch query parser supports the same constraint syntax as grep
  // (git:modified, globs, dir constraints), so we prepend constraints.
  return buildFffQuery(args.pattern, constraints);
}

export async function runFindFiles(
  args: FindFilesArgs,
  cwd: string,
  sandbox: SandboxConfig | undefined,
  scanTimeoutMs: number | undefined,
  getAbortSignal?: () => AbortSignal | undefined,
): Promise<FindFilesResult> {
  const started = Date.now();

  const searchPath = args.path
    ? isAbsolute(args.path)
      ? args.path
      : resolvePath(cwd, args.path)
    : cwd;

  const blockReason = sandboxBlockReason(searchPath, sandbox);
  if (blockReason) return { ok: false, error: blockReason };

  const signal = getAbortSignal?.();
  if (signal?.aborted) return { ok: false, error: "Interrupted" };

  let manager;
  try {
    manager = await getFffManager(cwd);
  } catch (e) {
    return { ok: false, error: `fff initialization failed: ${(e as Error).message}` };
  }

  if (!manager.isAvailable()) {
    const ready = await manager.ensureReady();
    const detail =
      getFffLoadError() ?? (ready.ok ? null : ready.error) ?? "unknown";
    return {
      ok: false,
      error: `fff not available: ${detail}. Install @ff-labs/fff-bun or check platform support.`,
    };
  }

  const timeoutMs = args.timeout ?? 5000;
  const maxResults = args.max_results ?? 50;
  const scanMs = scanTimeoutMs ?? 5000;

  const ready = await manager.ensureReady(Math.min(timeoutMs, scanMs));
  if (!ready.ok) {
    return { ok: false, error: `fff not ready: ${ready.error}` };
  }

  const rawFinder = manager.raw() as unknown as {
    fileSearch(query: string, opts: Record<string, unknown>): { ok: true; value: { items: Array<{ relativePath: string; fileName: string; size: number; modified: number; gitStatus: string }>; totalMatched: number; totalFiles: number } } | { ok: false; error: string };
    glob(pattern: string, opts: Record<string, unknown>): { ok: true; value: { items: Array<{ relativePath: string; fileName: string; size: number; modified: number; gitStatus: string }>; totalMatched: number; totalFiles: number } } | { ok: false; error: string };
  } | null;

  if (!rawFinder) {
    return { ok: false, error: "fff FileFinder not initialized" };
  }

  if (signal?.aborted) return { ok: false, error: "Interrupted" };

  const isGlob = args.mode === "glob";

  let result: { ok: true; value: { items: Array<{ relativePath: string; fileName: string; size: number; modified: number; gitStatus: string }>; totalMatched: number } } | { ok: false; error: string };

  try {
    if (isGlob) {
      // In glob mode, pattern is the glob itself. If a path constraint is
      // provided, prepend the directory so glob() can match within it.
      let globPattern = args.pattern;
      if (args.path) {
        const c = pathToConstraint(cwd, searchPath);
        if (c) {
          const dir = c.endsWith("/") ? c : `${c}/`;
          if (!globPattern.startsWith(dir)) {
            globPattern = `${dir}${globPattern}`;
          }
        }
      }
      result = rawFinder.glob(globPattern, { pageSize: maxResults });
    } else {
      const query = buildFindFilesQuery(args, cwd, searchPath);
      result = rawFinder.fileSearch(query, { pageSize: maxResults });
    }
  } catch (e) {
    return { ok: false, error: `fff search failed: ${(e as Error).message}` };
  }

  if (!result.ok) {
    return { ok: false, error: `fff error: ${result.error}` };
  }

  const raw = result.value;
  const totalMatched = raw.totalMatched ?? raw.items.length;
  const items = raw.items;
  const matches: FindFilesMatch[] = items.slice(0, maxResults).map((it) => ({
    file: join(cwd, it.relativePath),
    relative_path: it.relativePath,
    name: it.fileName,
    size: it.size,
    modified: it.modified,
    git_status: it.gitStatus ?? "unknown",
  }));

  const truncated = totalMatched > matches.length;
  return {
    ok: true,
    pattern: args.pattern,
    path: searchPath,
    matches,
    stats: {
      totalMatches: totalMatched,
      truncated,
      dropped: truncated ? totalMatched - matches.length : 0,
    },
    duration_ms: Date.now() - started,
  };
}

export function createFindFilesTool(ctx: FindFilesToolContext) {
  return {
    find_files: defineTool({
      description:
        "Fast fuzzy file search powered by fff. Returns file paths with metadata and git status. Use for finding files by name or path pattern. Supports fuzzy (typo-resistant) and glob modes.",
      parameters: findFilesSchema,
      execute: async (raw: unknown) => {
        const parsed = findFilesSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: `Invalid arguments: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          } satisfies FindFilesError;
        }
        return runFindFiles(parsed.data, ctx.cwd, ctx.sandbox, ctx.scanTimeoutMs, ctx.getAbortSignal);
      },
    }),
  };
}
