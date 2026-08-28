import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { resolve as resolvePath, isAbsolute, relative } from "node:path";
import type { SandboxConfig } from "../types.js";
import { pathToConstraint, sandboxBlockReason } from "../sandbox-path.js";
import { tryGetNative } from "../native/index.js";

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
    .describe("Directory to scope search"),
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

export function buildFindFilesQuery(
  args: FindFilesArgs,
  cwd: string,
  searchPath: string,
): string {
  const constraints: string[] = [];
  if (args.path) {
    const c = pathToConstraint(cwd, searchPath);
    if (c) constraints.push(c);
  }
  if (constraints.length === 0) return args.pattern;
  return `${constraints.join(" ")} ${args.pattern}`;
}

export async function runFindFiles(
  args: FindFilesArgs,
  cwd: string,
  sandbox: SandboxConfig | undefined,
  _scanTimeoutMs: number | undefined,
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

  const native = await tryGetNative();
  if (!native) {
    return {
      ok: false,
      error:
        "native search unavailable. Install @praana/natives or keep praana-natives.node beside the standalone binary.",
    };
  }

  if (signal?.aborted) return { ok: false, error: "Interrupted" };

  const maxResults = args.max_results ?? 50;
  let result;
  try {
    result = native.findFiles({
      pattern: args.pattern,
      path: searchPath,
      mode: args.mode ?? "fuzzy",
      maxResults,
    });
  } catch (e) {
    return { ok: false, error: `native find_files failed: ${(e as Error).message}` };
  }

  if (!result.ok) {
    return { ok: false, error: result.error ?? "native find_files failed" };
  }

  const totalMatched = result.totalMatched ?? result.matches.length;
  const matches: FindFilesMatch[] = result.matches.slice(0, maxResults).map((it) => {
    const abs = it.path;
    let rel: string;
    try {
      rel = relative(cwd, abs).replace(/\\/g, "/");
    } catch {
      rel = it.relativePath;
    }
    return {
      file: abs,
      relative_path: rel,
      name: it.name,
      size: it.size,
      modified: it.modified,
      git_status: "unknown",
    };
  });

  const truncated = result.truncated || totalMatched > matches.length;
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
        "Fast fuzzy file search powered by the native addon. Returns file paths with metadata. Use for finding files by name or path pattern. Supports fuzzy (typo-resistant) and glob modes.",
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
        return runFindFiles(
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
