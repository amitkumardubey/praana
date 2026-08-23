import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { existsSync, realpathSync } from "node:fs";
import { resolve as resolvePath, isAbsolute, normalize, join } from "node:path";
import { homedir } from "node:os";
import type { SandboxConfig } from "../types.js";
import { buildFffQuery, pathToConstraint } from "../fff.js";

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

function sandboxBlockReason(
  path: string,
  sandbox: SandboxConfig | undefined,
): string | null {
  if (!sandbox?.enabled || sandbox.allowed_paths.length === 0) return null;
  const resolve = (p: string): string => {
    const expanded = p.replace(/^~/, homedir());
    const normalized = normalize(expanded);
    if (!existsSync(normalized)) return normalized;
    try {
      return realpathSync(normalized);
    } catch {
      return normalized;
    }
  };
  const resolved = resolve(path);
  const allowed = sandbox.allowed_paths.some((ap) => {
    const apResolved = resolve(ap);
    return resolved === apResolved || resolved.startsWith(apResolved + "/");
  });
  return allowed ? null : `Blocked by sandbox: path not in allowed list: ${path}`;
}

const findFilesFffCache = new Map<string, Promise<import("../fff.js").FffManager>>();

async function getFffManager(cwd: string): Promise<import("../fff.js").FffManager> {
  let cached = findFilesFffCache.get(cwd);
  if (cached) return cached;
  const promise = (async () => {
    const { createFffManager } = await import("../fff.js");
    return createFffManager(cwd);
  })();
  findFilesFffCache.set(cwd, promise);
  return promise;
}

export function clearFindFilesFffCache(): void {
  for (const [, p] of findFilesFffCache) {
    void p.then((m) => {
      try { m.destroy(); } catch { /* ignore */ }
    });
  }
  findFilesFffCache.clear();
}

export function buildFindFilesQuery(args: FindFilesArgs, cwd: string, searchPath: string): string {
  // For find_files, path constraint is the directory scope.
  // In glob mode, pattern itself is a glob; path is extra constraint.
  const constraints: string[] = [];
  if (args.path) {
    const c = pathToConstraint(cwd, searchPath);
    if (c) constraints.push(c);
  }
  if (constraints.length === 0) return args.pattern;
  // For fileSearch, constraints are prepended to query just like grep.
  // However fff's fileSearch query parser also supports the same constraint syntax
  // (git:modified, globs, etc.) so this is correct.
  return buildFffQuery(args.pattern, constraints);
}

export async function runFindFiles(
  args: FindFilesArgs,
  cwd: string,
  sandbox: SandboxConfig | undefined,
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

  let manager: import("../fff.js").FffManager;
  try {
    manager = await getFffManager(cwd);
  } catch (e) {
    return { ok: false, error: `fff initialization failed: ${(e as Error).message}` };
  }

  if (!manager.isAvailable()) {
    const { getFffLoadError } = await import("../fff.js");
    const detail = getFffLoadError() ?? "unknown";
    return {
      ok: false,
      error: `fff not available: ${detail}. Install @ff-labs/fff-bun or check platform support.`,
    };
  }

  const timeoutMs = args.timeout ?? 5000;
  const maxResults = args.max_results ?? 50;

  const ready = await manager.ensureReady(Math.min(timeoutMs, 5000));
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
      // In glob mode, pattern is the glob itself; path constraint already handled via query building?
      // For glob, we pass the pattern directly to finder.glob().
      // If there's a path constraint, we need to combine: glob pattern should be path + pattern?
      // Simpler: use fileSearch with glob constraint — but spec says glob() is pure glob without fuzzy.
      // So for glob mode with path, we prefix the glob: "path/*.ts"
      let globPattern = args.pattern;
      if (args.path) {
        const c = pathToConstraint(cwd, searchPath);
        if (c) {
          const dir = c.endsWith("/") ? c : `${c}/`;
          if (!globPattern.startsWith(dir) && !globPattern.includes("/")) {
            globPattern = `${dir}${globPattern}`;
          } else if (!globPattern.startsWith(dir)) {
            // Prepend dir as constraint before glob — fileSearch style would work,
            // but glob() doesn't support constraint syntax, so we embed dir.
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
  const items = raw.items;
  const matches: FindFilesMatch[] = items.slice(0, maxResults).map((it) => ({
    file: join(cwd, it.relativePath),
    relative_path: it.relativePath,
    name: it.fileName,
    size: it.size,
    modified: it.modified,
    git_status: (it as unknown as { gitStatus: string }).gitStatus ?? "unknown",
  }));

  const truncated = raw.totalMatched > matches.length;
  return {
    ok: true,
    pattern: args.pattern,
    path: searchPath,
    matches,
    stats: {
      totalMatches: raw.totalMatched,
      truncated,
      dropped: truncated ? raw.totalMatched - matches.length : 0,
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
        return runFindFiles(parsed.data, ctx.cwd, ctx.sandbox, ctx.getAbortSignal);
      },
    }),
  };
}
