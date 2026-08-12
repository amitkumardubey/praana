/**
 * Tree-sitter code intelligence tools (issue #11 Phase 1).
 *
 * Backed by @praana/natives. Soft-fails when the addon is unavailable.
 * Name-based project queries — not type-aware / LSP resolution.
 */

import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { SandboxConfig } from "../types.js";
import { loadNative, type NativeBindings } from "../native/index.js";

export interface CodeIntelToolsContext {
  cwd: string;
  sandbox?: SandboxConfig;
  /** Test injection — bypasses loadNative when set. */
  getNative?: () => Promise<NativeBindings | null>;
}

export interface CodeToolError {
  ok: false;
  error: string;
  code: string;
}

function sandboxBlockReason(
  path: string,
  sandbox: SandboxConfig | undefined,
): string | null {
  if (!sandbox?.enabled || sandbox.allowed_paths.length === 0) return null;

  const resolvePath = (p: string): string => {
    const expanded = p.replace(/^~/, homedir());
    const normalized = normalize(expanded);
    if (!existsSync(normalized)) return normalized;
    try {
      return realpathSync(normalized);
    } catch {
      return normalized;
    }
  };

  const resolved = resolvePath(path);
  const allowed = sandbox.allowed_paths.some((ap) => {
    const apResolved = resolvePath(ap);
    return resolved === apResolved || resolved.startsWith(apResolved + "/");
  });

  return allowed
    ? null
    : `Blocked by sandbox: path not in allowed list: ${path}`;
}

function resolveUserPath(cwd: string, path: string): string {
  const expanded = path.replace(/^~/, homedir());
  return isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);
}

function isCodeToolError(
  value: NativeBindings | CodeToolError,
): value is CodeToolError {
  return "ok" in value && value.ok === false;
}

async function resolveNative(
  ctx: CodeIntelToolsContext,
): Promise<NativeBindings | CodeToolError> {
  if (ctx.getNative) {
    const bindings = await ctx.getNative();
    if (!bindings) {
      return {
        ok: false,
        error: "native unavailable: injected bindings missing",
        code: "unavailable",
      };
    }
    return bindings;
  }
  const loaded = await loadNative();
  if (!loaded.available || !loaded.bindings) {
    const detail =
      loaded.error?.causeMessage ??
      loaded.error?.message ??
      "addon not loaded";
    return {
      ok: false,
      error: `native unavailable: ${detail}`,
      code: loaded.error?.code ?? "unavailable",
    };
  }
  return loaded.bindings;
}

function ensureFilePath(
  absPath: string,
  sandbox: SandboxConfig | undefined,
): CodeToolError | null {
  const blocked = sandboxBlockReason(absPath, sandbox);
  if (blocked) return { ok: false, error: blocked, code: "invalid_argument" };
  if (!existsSync(absPath)) {
    return { ok: false, error: `File not found: ${absPath}`, code: "io_error" };
  }
  try {
    if (!statSync(absPath).isFile()) {
      return {
        ok: false,
        error: `Not a file: ${absPath}`,
        code: "invalid_argument",
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      code: "io_error",
    };
  }
  return null;
}

function ensureDirPath(
  absPath: string,
  sandbox: SandboxConfig | undefined,
): CodeToolError | null {
  const blocked = sandboxBlockReason(absPath, sandbox);
  if (blocked) return { ok: false, error: blocked, code: "invalid_argument" };
  if (!existsSync(absPath)) {
    return {
      ok: false,
      error: `Directory not found: ${absPath}`,
      code: "io_error",
    };
  }
  try {
    if (!statSync(absPath).isDirectory()) {
      return {
        ok: false,
        error: `Not a directory: ${absPath}`,
        code: "invalid_argument",
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      code: "io_error",
    };
  }
  return null;
}

const pathSchema = z.string().min(1).describe("File path (relative to cwd or absolute)");
const languageSchema = z
  .string()
  .optional()
  .describe(
    "Language override: typescript | tsx | javascript | jsx | python | go",
  );

const projectOptsSchema = {
  language: languageSchema,
  max_files: z
    .number()
    .int()
    .min(1)
    .max(50_000)
    .optional()
    .describe("Max source files to scan (default 2000)"),
  max_hits: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe("Max hits to return (default 100)"),
};

export function createCodeIntelTools(ctx: CodeIntelToolsContext) {
  return {
    code_parse: defineTool({
      description:
        "Parse a source file with tree-sitter and return syntax diagnostics (TS/JS/Python/Go/Rust). Soft-fails if native addon unavailable.",
      parameters: z.object({
        path: pathSchema,
        language: languageSchema,
      }),
      execute: async (args: { path: string; language?: string }) => {
        const native = await resolveNative(ctx);
        if (isCodeToolError(native)) return native;
        const abs = resolveUserPath(ctx.cwd, args.path);
        const err = ensureFilePath(abs, ctx.sandbox);
        if (err) return err;
        const result = native.parseFile(abs, args.language);
        if (!result.ok) {
          return {
            ok: false as const,
            error: result.error ?? "parse failed",
            code: result.code ?? "parse_error",
          };
        }
        return {
          ok: true as const,
          path: abs,
          language: result.language ?? null,
          diagnostics: result.diagnostics ?? [],
        };
      },
    }),

    code_imports: defineTool({
      description:
        "List structured imports for a source file (tree-sitter; TS/JS/Python/Go/Rust). Soft-fails if native addon unavailable.",
      parameters: z.object({
        path: pathSchema,
        language: languageSchema,
      }),
      execute: async (args: { path: string; language?: string }) => {
        const native = await resolveNative(ctx);
        if (isCodeToolError(native)) return native;
        const abs = resolveUserPath(ctx.cwd, args.path);
        const err = ensureFilePath(abs, ctx.sandbox);
        if (err) return err;
        const result = native.listImports(abs, args.language);
        if (!result.ok) {
          return {
            ok: false as const,
            error: result.error ?? "listImports failed",
            code: result.code ?? "internal",
          };
        }
        return {
          ok: true as const,
          path: abs,
          language: result.language ?? null,
          imports: result.imports ?? [],
        };
      },
    }),

    code_symbols: defineTool({
      description:
        "List top-level / exported symbols in a source file (tree-sitter; TS/JS/Python/Go/Rust). Soft-fails if native addon unavailable.",
      parameters: z.object({
        path: pathSchema,
        language: languageSchema,
      }),
      execute: async (args: { path: string; language?: string }) => {
        const native = await resolveNative(ctx);
        if (isCodeToolError(native)) return native;
        const abs = resolveUserPath(ctx.cwd, args.path);
        const err = ensureFilePath(abs, ctx.sandbox);
        if (err) return err;
        const result = native.listSymbols(abs, args.language);
        if (!result.ok) {
          return {
            ok: false as const,
            error: result.error ?? "listSymbols failed",
            code: result.code ?? "internal",
          };
        }
        return {
          ok: true as const,
          path: abs,
          language: result.language ?? null,
          symbols: result.symbols ?? [],
        };
      },
    }),

    code_definition: defineTool({
      description:
        "Find name-based definition hits for a symbol under a project root (tree-sitter walk; not type-aware). Soft-fails if native addon unavailable.",
      parameters: z.object({
        symbol: z.string().min(1).describe("Symbol name to find definitions for"),
        root: z
          .string()
          .optional()
          .describe("Project root to search (default: cwd)"),
        ...projectOptsSchema,
      }),
      execute: async (args: {
        symbol: string;
        root?: string;
        language?: string;
        max_files?: number;
        max_hits?: number;
      }) => {
        const native = await resolveNative(ctx);
        if (isCodeToolError(native)) return native;
        const absRoot = resolveUserPath(ctx.cwd, args.root ?? ".");
        const err = ensureDirPath(absRoot, ctx.sandbox);
        if (err) return err;
        const result = native.findDefinition(absRoot, args.symbol, {
          language: args.language,
          maxFiles: args.max_files,
          maxHits: args.max_hits,
        });
        if (!result.ok) {
          return {
            ok: false as const,
            error: result.error ?? "findDefinition failed",
            code: result.code ?? "internal",
          };
        }
        return {
          ok: true as const,
          symbol: args.symbol,
          root: absRoot,
          hits: result.hits ?? [],
          truncated: result.truncated ?? false,
          files_scanned: result.filesScanned ?? 0,
        };
      },
    }),

    code_references: defineTool({
      description:
        "Find name-based reference hits for a symbol under a project root (tree-sitter walk; not type-aware). Soft-fails if native addon unavailable.",
      parameters: z.object({
        symbol: z.string().min(1).describe("Symbol name to find references for"),
        root: z
          .string()
          .optional()
          .describe("Project root to search (default: cwd)"),
        ...projectOptsSchema,
      }),
      execute: async (args: {
        symbol: string;
        root?: string;
        language?: string;
        max_files?: number;
        max_hits?: number;
      }) => {
        const native = await resolveNative(ctx);
        if (isCodeToolError(native)) return native;
        const absRoot = resolveUserPath(ctx.cwd, args.root ?? ".");
        const err = ensureDirPath(absRoot, ctx.sandbox);
        if (err) return err;
        const result = native.findReferences(absRoot, args.symbol, {
          language: args.language,
          maxFiles: args.max_files,
          maxHits: args.max_hits,
        });
        if (!result.ok) {
          return {
            ok: false as const,
            error: result.error ?? "findReferences failed",
            code: result.code ?? "internal",
          };
        }
        return {
          ok: true as const,
          symbol: args.symbol,
          root: absRoot,
          hits: result.hits ?? [],
          truncated: result.truncated ?? false,
          files_scanned: result.filesScanned ?? 0,
        };
      },
    }),
  };
}
