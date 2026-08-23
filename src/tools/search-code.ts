import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { existsSync, realpathSync } from "node:fs";
import { resolve as resolvePath, isAbsolute, normalize, join } from "node:path";
import { homedir } from "node:os";
import type { SandboxConfig } from "../types.js";
import {
  buildFffQuery,
  fileTypeToConstraint,
  pathToConstraint,
} from "../fff.js";

/**
 * search_code — fff-backed structured code search.
 *
 * Wraps fff's grep with a stable JSON contract:
 *   { matches: [{ file, line, column, text, context_before, context_after }],
 *     stats:   { totalMatches, filesWithMatches, truncated } }
 *
 * The FileFinder is created lazily per cwd and kept alive for the process;
 * the initial scan runs in the background and the first search waits for it.
 */

export interface SearchCodeMatch {
  file: string;
  line: number;
  column: number;
  text: string;
  context_before: string[];
  context_after: string[];
}

export interface SearchCodeStats {
  totalMatches: number;
  filesWithMatches: number;
  truncated: boolean;
  dropped: number;
}

export interface SearchCodeSuccess {
  ok: true;
  pattern: string;
  path: string;
  matches: SearchCodeMatch[];
  stats: SearchCodeStats;
  duration_ms: number;
}

export interface SearchCodeError {
  ok: false;
  error: string;
}

export type SearchCodeResult = SearchCodeSuccess | SearchCodeError;

export interface SearchCodeToolContext {
  cwd: string;
  getAbortSignal?: () => AbortSignal | undefined;
  sandbox?: SandboxConfig;
}

const searchCodeSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("Regex pattern to search for (regex syntax, fff-backed)"),
  path: z
    .string()
    .optional()
    .describe("Directory or file to search (default: working directory)"),
  glob: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Include glob filter(s), e.g. '*.ts' or ['*.ts', '*.tsx']"),
  glob_exclude: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Exclude glob filter(s)"),
  case_insensitive: z
    .boolean()
    .optional()
    .describe("Case-insensitive search"),
  context: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Lines of context before and after each match. Default 0."),
  max_results: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Stop after this many matches are found"),
  file_type: z
    .string()
    .optional()
    .describe("File type filter (e.g. 'ts', 'rust', 'py') — mapped to extension glob"),
  timeout: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Timeout in milliseconds (default 30000, mapped to timeBudgetMs)"),
});

export type SearchCodeArgs = z.infer<typeof searchCodeSchema>;

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

  return allowed
    ? null
    : `Blocked by sandbox: path not in allowed list: ${path}`;
}

// Map cwd -> FffManager (created lazily, scan runs in background).
const fffCache = new Map<string, Promise<import("../fff.js").FffManager>>();

async function getFffManager(cwd: string): Promise<import("../fff.js").FffManager> {
  let cached = fffCache.get(cwd);
  if (cached) return cached;
  const promise = (async () => {
    const { createFffManager } = await import("../fff.js");
    return createFffManager(cwd);
  })();
  fffCache.set(cwd, promise);
  return promise;
}

/** For tests: clear the fff cache. */
export function clearFffCache(): void {
  for (const [, p] of fffCache) {
    void p.then((m) => {
      try { m.destroy(); } catch { /* ignore */ }
    });
  }
  fffCache.clear();
}

export function buildFffConstraints(
  args: SearchCodeArgs,
  cwd: string,
  searchPath: string,
): string[] {
  const constraints: string[] = [];

  // path constraint
  if (args.path) {
    const c = pathToConstraint(cwd, searchPath);
    if (c) constraints.push(c);
  }

  // file_type constraint
  if (args.file_type) {
    constraints.push(fileTypeToConstraint(args.file_type));
  }

  // include globs
  for (const g of args.glob ? (Array.isArray(args.glob) ? args.glob : [args.glob]) : []) {
    constraints.push(g);
  }
  // exclude globs
  for (const g of args.glob_exclude
    ? Array.isArray(args.glob_exclude)
      ? args.glob_exclude
      : [args.glob_exclude]
    : []) {
    constraints.push(g.startsWith("!") ? g : `!${g}`);
  }

  return constraints;
}

export function buildFffGrepQuery(args: SearchCodeArgs, cwd: string, searchPath: string): string {
  const constraints = buildFffConstraints(args, cwd, searchPath);
  let pattern = args.pattern;
  if (args.case_insensitive) {
    // In regex mode, use inline (?i) flag; avoid lowercasing which breaks char classes.
    if (!pattern.startsWith("(?i)")) {
      pattern = `(?i)${pattern}`;
    }
  }
  return buildFffQuery(pattern, constraints);
}

export async function runFffSearch(
  args: SearchCodeArgs,
  cwd: string,
  sandbox: SandboxConfig | undefined,
  getAbortSignal?: () => AbortSignal | undefined,
): Promise<SearchCodeResult> {
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
    // Try to get detailed error
    const { getFffLoadError } = await import("../fff.js");
    const detail = getFffLoadError() ?? "unknown";
    return {
      ok: false,
      error: `fff not available: ${detail}. Install @ff-labs/fff-bun or check platform support.`,
    };
  }

  const ctx = args.context ?? 0;
  const maxResults = args.max_results;
  const timeoutMs = args.timeout ?? 30_000;

  // Wait for scan (with timeout)
  const ready = await manager.ensureReady(Math.min(timeoutMs, 5000));
  if (!ready.ok) {
    return { ok: false, error: `fff not ready: ${ready.error}` };
  }

  const fffQuery = buildFffGrepQuery(args, cwd, searchPath);

  const rawFinder = manager.raw() as unknown as {
    grep(query: string, opts: Record<string, unknown>): { ok: true; value: unknown } | { ok: false; error: string };
  } | null;

  if (!rawFinder) {
    return { ok: false, error: "fff FileFinder not initialized" };
  }

  const grepOpts: Record<string, unknown> = {
    mode: "regex",
    maxFileSize: 10 * 1024 * 1024,
    maxMatchesPerFile: 200,
    smartCase: !args.case_insensitive,
    beforeContext: ctx,
    afterContext: ctx,
    pageSize: maxResults ?? 200,
    timeBudgetMs: timeoutMs,
  };

  // Check abort before grep (grep is sync, so we can't abort mid-search)
  if (signal?.aborted) return { ok: false, error: "Interrupted" };

  let grepResult: { ok: true; value: { items: Array<Record<string, unknown>>; totalMatched: number; totalFilesSearched: number; totalFiles: number; filteredFileCount: number; nextCursor: unknown | null; regexFallbackError?: string } } | { ok: false; error: string };
  try {
    grepResult = rawFinder.grep(fffQuery, grepOpts) as typeof grepResult;
  } catch (e) {
    return { ok: false, error: `fff grep failed: ${(e as Error).message}` };
  }

  if (!grepResult.ok) {
    return { ok: false, error: `fff error: ${grepResult.error}` };
  }

  const raw = grepResult.value;
  const items = raw.items as Array<{
    relativePath: string;
    fileName: string;
    lineNumber: number;
    col: number;
    lineContent: string;
    contextBefore?: string[];
    contextAfter?: string[];
  }>;

  const matches: SearchCodeMatch[] = items.slice(0, maxResults ?? items.length).map((m) => ({
    file: join(cwd, m.relativePath),
    line: m.lineNumber,
    column: m.col + 1,
    text: m.lineContent,
    context_before: m.contextBefore ?? [],
    context_after: m.contextAfter ?? [],
  }));

  const truncated = raw.nextCursor !== null && raw.nextCursor !== undefined ? true : (maxResults !== undefined && items.length >= maxResults);
  const filesWithMatches = new Set(matches.map((m) => m.file)).size;

  return {
    ok: true,
    pattern: args.pattern,
    path: searchPath,
    matches,
    stats: {
      totalMatches: matches.length,
      filesWithMatches,
      truncated,
      dropped: truncated ? 1 : 0,
    },
    duration_ms: Date.now() - started,
  };
}

export function createSearchCodeTool(ctx: SearchCodeToolContext) {
  return {
    search_code: defineTool({
      description:
        "Fast structured code search powered by fff. Returns file:line:column matches with optional context lines. Use instead of `shell grep` for codebase exploration.",
      parameters: searchCodeSchema,
      execute: async (raw: unknown) => {
        const parsed = searchCodeSchema.safeParse(raw);
        if (!parsed.success) {
          return {
            ok: false,
            error: `Invalid arguments: ${parsed.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}`,
          } satisfies SearchCodeError;
        }
        return runFffSearch(
          parsed.data,
          ctx.cwd,
          ctx.sandbox,
          ctx.getAbortSignal,
        );
      },
    }),
  };
}
