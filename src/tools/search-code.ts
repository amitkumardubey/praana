import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { resolve as resolvePath, isAbsolute, join } from "node:path";
import type { SandboxConfig } from "../types.js";
import {
  buildFffQuery,
  fileTypeToConstraint,
  pathToConstraint,
  sandboxBlockReason,
  getFffManager,
  clearFffCache,
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
 *
 * Note: fff's `grep()` is synchronous (not Promise-returning). This means the
 * search blocks the event loop while running. The `timeBudgetMs` option limits
 * search duration but does not make the call abortable — an AbortSignal cannot
 * interrupt a running grep. This is a known tradeoff of the in-process native
 * index vs. a child-process approach like the old `rg --json` streaming.
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
  regex_fallback?: string | null;
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
  scanTimeoutMs?: number;
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
  scanTimeoutMs: number | undefined,
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

  let manager;
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

  const ctx = args.context ?? 0;
  const maxResults = args.max_results;
  const timeoutMs = args.timeout ?? 30_000;
  const scanMs = scanTimeoutMs ?? 5000;

  // Wait for scan (with timeout)
  const ready = await manager.ensureReady(Math.min(timeoutMs, scanMs));
  if (!ready.ok) {
    return { ok: false, error: `fff not ready: ${ready.error}` };
  }

  const fffQuery = buildFffGrepQuery(args, cwd, searchPath);

  const rawFinder = manager.raw() as unknown as {
    grep(query: string, opts: Record<string, unknown>): { ok: true; value: { items: Array<{ relativePath: string; lineNumber: number; col: number; lineContent: string; contextBefore?: string[]; contextAfter?: string[] }>; totalMatched: number; totalFilesSearched: number; totalFiles: number; filteredFileCount: number; nextCursor: unknown | null; regexFallbackError?: string } } | { ok: false; error: string };
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
  const totalMatched = raw.totalMatched ?? raw.items.length;
  const items = raw.items as Array<{
    relativePath: string;
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

  const truncated =
    raw.nextCursor !== null && raw.nextCursor !== undefined
      ? true
      : maxResults !== undefined && items.length >= maxResults;
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
      dropped: truncated ? Math.max(totalMatched - matches.length, 1) : 0,
    },
    duration_ms: Date.now() - started,
    regex_fallback: raw.regexFallbackError ?? null,
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
          ctx.scanTimeoutMs,
          ctx.getAbortSignal,
        );
      },
    }),
  };
}
