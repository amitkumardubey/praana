import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { resolve as resolvePath, isAbsolute } from "node:path";
import type { SandboxConfig } from "../types.js";
import {
  fileTypeToGlob,
  pathToConstraint,
  sandboxBlockReason,
  toStringList,
} from "../sandbox-path.js";
import { tryGetNative } from "../native/index.js";

/**
 * search_code — native grep via `@praana/natives`.
 *
 * Stable JSON contract:
 *   { matches: [{ file, line, column, text, context_before, context_after }],
 *     stats:   { totalMatches, filesWithMatches, truncated } }
 *
 * Grep is synchronous and blocks the event loop. An AbortSignal cannot
 * interrupt a running search. Use `shell rg` for huge trees or interactive abort.
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
    .describe("Regex pattern to search for (regex syntax, native grep)"),
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
    .describe("Timeout in milliseconds (default 30000)"),
});

export type SearchCodeArgs = z.infer<typeof searchCodeSchema>;

export function collectIncludeGlobs(args: SearchCodeArgs): string[] {
  const globs = [...toStringList(args.glob)];
  if (args.file_type) globs.push(fileTypeToGlob(args.file_type));
  return globs;
}

export function collectExcludeGlobs(args: SearchCodeArgs): string[] {
  return toStringList(args.glob_exclude).map((g) =>
    g.startsWith("!") ? g.slice(1) : g,
  );
}

export function buildFffConstraints(
  args: SearchCodeArgs,
  cwd: string,
  searchPath: string,
): string[] {
  const constraints: string[] = [];
  if (args.path) {
    const c = pathToConstraint(cwd, searchPath);
    if (c) constraints.push(c);
  }
  constraints.push(...collectIncludeGlobs(args));
  for (const g of collectExcludeGlobs(args)) {
    constraints.push(g.startsWith("!") ? g : `!${g}`);
  }
  return constraints;
}

export function buildFffGrepQuery(
  args: SearchCodeArgs,
  _cwd: string,
  _searchPath: string,
): string {
  let pattern = args.pattern;
  if (args.case_insensitive && !pattern.startsWith("(?i)")) {
    pattern = `(?i)${pattern}`;
  }
  const extras = [
    ...collectIncludeGlobs(args),
    ...collectExcludeGlobs(args).map((g) => `!${g}`),
  ].filter(Boolean);
  if (extras.length === 0) return pattern;
  return `${extras.join(" ")} ${pattern}`;
}

export async function runNativeSearch(
  args: SearchCodeArgs,
  cwd: string,
  sandbox: SandboxConfig | undefined,
  _scanTimeoutMs: number | undefined,
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

  const native = await tryGetNative();
  if (!native) {
    return {
      ok: false,
      error:
        "native search unavailable. Install @praana/natives or keep praana-natives.node beside the standalone binary.",
    };
  }

  if (signal?.aborted) return { ok: false, error: "Interrupted" };

  const timeoutMs = args.timeout ?? 30_000;
  let result;
  try {
    result = native.grep({
      pattern: args.pattern,
      path: searchPath,
      globs: collectIncludeGlobs(args),
      globExclude: collectExcludeGlobs(args),
      caseInsensitive: args.case_insensitive ?? false,
      context: args.context ?? 0,
      maxResults: args.max_results ?? 200,
      maxFileSize: 10 * 1024 * 1024,
      timeBudgetMs: timeoutMs,
    });
  } catch (e) {
    return { ok: false, error: `native grep failed: ${(e as Error).message}` };
  }

  if (!result.ok) {
    return { ok: false, error: result.error ?? "native grep failed" };
  }

  const maxResults = args.max_results;
  const items = result.matches;
  const matches: SearchCodeMatch[] = items
    .slice(0, maxResults ?? items.length)
    .map((m) => ({
      file: m.path,
      line: m.line,
      column: m.column,
      text: m.text,
      context_before: m.contextBefore ?? [],
      context_after: m.contextAfter ?? [],
    }));

  const truncated =
    result.truncated ||
    (maxResults !== undefined && items.length >= maxResults);
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
      dropped: truncated ? Math.max(items.length - matches.length, 1) : 0,
    },
    duration_ms: Date.now() - started,
    regex_fallback: result.regexFallback ?? null,
  };
}

/** @deprecated Use runNativeSearch. */
export const runFffSearch = runNativeSearch;

export function createSearchCodeTool(ctx: SearchCodeToolContext) {
  return {
    search_code: defineTool({
      description:
        "Fast structured code search powered by the native addon. Returns file:line:column matches with optional context lines. Use instead of `shell grep` for codebase exploration. Use `shell rg` for huge trees or when you need to abort.",
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
        return runNativeSearch(
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
