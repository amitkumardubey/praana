/**
 * LSP agent tools (issue #11 Phase 2).
 */

import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import type { SandboxConfig } from "../types.js";
import type { LspManager } from "../lsp/manager.js";
import { languageFromPath } from "../lsp/language.js";

export interface LspToolsContext {
  cwd: string;
  sandbox?: SandboxConfig;
  getLsp: () => LspManager | null;
  clearReadPath?: (absPath: string) => void;
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

function ensureFilePath(
  absPath: string,
  sandbox: SandboxConfig | undefined,
): { ok: false; error: string; code: string } | null {
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

const pathSchema = z
  .string()
  .min(1)
  .describe("File path (relative to cwd or absolute)");

const coordSchema = z
  .number()
  .int()
  .positive()
  .describe("1-based line or column");

function missingManager() {
  return {
    ok: false as const,
    error: "LSP unavailable: manager not initialized",
    code: "unavailable",
  };
}

function failResult(result: { error: string; code: string }) {
  return {
    ok: false as const,
    error: result.error,
    code: result.code,
  };
}

export function createLspTools(ctx: LspToolsContext) {
  function resolveReady(path: string) {
    const mgr = ctx.getLsp();
    if (!mgr) return { mgr: null as LspManager | null, err: missingManager() };
    const abs = resolveUserPath(ctx.cwd, path);
    const pathErr = ensureFilePath(abs, ctx.sandbox);
    if (pathErr) return { mgr: null, err: pathErr, abs };
    return { mgr, abs, err: null };
  }

  return {
    lsp_diagnostics: defineTool({
      description:
        "Return LSP diagnostics for a source file (TypeScript/JavaScript when a server is configured). Soft-fails when LSP is disabled or unavailable.",
      parameters: z.object({
        path: pathSchema,
      }),
      execute: async (args: { path: string }) => {
        const ready = resolveReady(args.path);
        if (!ready.mgr || !ready.abs) return ready.err!;
        const result = await ready.mgr.diagnostics(ready.abs);
        if (!result.ok) return failResult(result);
        return {
          ok: true as const,
          path: ready.abs,
          language: languageFromPath(ready.abs),
          diagnostics: result.value,
        };
      },
    }),

    lsp_format: defineTool({
      description:
        "Format a source file via the configured LSP server. Mutating; blocked in plan mode. Soft-fails when LSP is disabled or unavailable.",
      parameters: z.object({
        path: pathSchema,
      }),
      execute: async (args: { path: string }) => {
        const ready = resolveReady(args.path);
        if (!ready.mgr || !ready.abs) return ready.err!;
        const result = await ready.mgr.format(ready.abs);
        if (!result.ok) return failResult(result);
        if (result.value.changed) {
          ctx.clearReadPath?.(ready.abs);
        }
        return {
          ok: true as const,
          path: ready.abs,
          language: languageFromPath(ready.abs),
          changed: result.value.changed,
          ...(result.value.skipped
            ? { skipped: result.value.skipped }
            : {}),
        };
      },
    }),

    lsp_hover: defineTool({
      description:
        "Type and documentation at a 1-based position via LSP. Soft-fails when disabled. Prefer code_* for fast in-project name queries.",
      parameters: z.object({
        path: pathSchema,
        line: coordSchema,
        col: coordSchema,
      }),
      execute: async (args: { path: string; line: number; col: number }) => {
        const ready = resolveReady(args.path);
        if (!ready.mgr || !ready.abs) return ready.err!;
        const result = await ready.mgr.hover(ready.abs, args.line, args.col);
        if (!result.ok) return failResult(result);
        return {
          ok: true as const,
          path: ready.abs,
          language: languageFromPath(ready.abs),
          line: args.line,
          col: args.col,
          hover: result.value.hover,
          ...(result.value.skipped ? { skipped: result.value.skipped } : {}),
        };
      },
    }),

    lsp_completions: defineTool({
      description:
        "Up to 20 completion labels at a position (no insert/apply). Soft-fails when LSP is disabled.",
      parameters: z.object({
        path: pathSchema,
        line: coordSchema,
        col: coordSchema,
      }),
      execute: async (args: { path: string; line: number; col: number }) => {
        const ready = resolveReady(args.path);
        if (!ready.mgr || !ready.abs) return ready.err!;
        const result = await ready.mgr.completions(
          ready.abs,
          args.line,
          args.col,
        );
        if (!result.ok) return failResult(result);
        return {
          ok: true as const,
          path: ready.abs,
          language: languageFromPath(ready.abs),
          line: args.line,
          col: args.col,
          completions: result.value.completions,
          ...(result.value.truncated ? { truncated: true } : {}),
          ...(result.value.skipped ? { skipped: result.value.skipped } : {}),
        };
      },
    }),

    lsp_definition: defineTool({
      description:
        "Semantic definition locations at a 1-based position (stdlib/deps). Use code_definition for name-based project search.",
      parameters: z.object({
        path: pathSchema,
        line: coordSchema,
        col: coordSchema,
      }),
      execute: async (args: { path: string; line: number; col: number }) => {
        const ready = resolveReady(args.path);
        if (!ready.mgr || !ready.abs) return ready.err!;
        const result = await ready.mgr.definition(
          ready.abs,
          args.line,
          args.col,
        );
        if (!result.ok) return failResult(result);
        return {
          ok: true as const,
          path: ready.abs,
          language: languageFromPath(ready.abs),
          line: args.line,
          col: args.col,
          locations: result.value.locations,
          ...(result.value.truncated ? { truncated: true } : {}),
          ...(result.value.skipped ? { skipped: result.value.skipped } : {}),
        };
      },
    }),

    lsp_references: defineTool({
      description:
        "Semantic references at a 1-based position. Use code_references for name-based project search.",
      parameters: z.object({
        path: pathSchema,
        line: coordSchema,
        col: coordSchema,
      }),
      execute: async (args: { path: string; line: number; col: number }) => {
        const ready = resolveReady(args.path);
        if (!ready.mgr || !ready.abs) return ready.err!;
        const result = await ready.mgr.references(
          ready.abs,
          args.line,
          args.col,
        );
        if (!result.ok) return failResult(result);
        return {
          ok: true as const,
          path: ready.abs,
          language: languageFromPath(ready.abs),
          line: args.line,
          col: args.col,
          locations: result.value.locations,
          ...(result.value.truncated ? { truncated: true } : {}),
          ...(result.value.skipped ? { skipped: result.value.skipped } : {}),
        };
      },
    }),

    lsp_code_actions: defineTool({
      description:
        "List applicable LSP code actions for a 1-based range. Returns opaque ids for lsp_apply_code_action.",
      parameters: z.object({
        path: pathSchema,
        startLine: coordSchema,
        startCol: coordSchema,
        endLine: coordSchema,
        endCol: coordSchema,
      }),
      execute: async (args: {
        path: string;
        startLine: number;
        startCol: number;
        endLine: number;
        endCol: number;
      }) => {
        const ready = resolveReady(args.path);
        if (!ready.mgr || !ready.abs) return ready.err!;
        const result = await ready.mgr.codeActions(
          ready.abs,
          args.startLine,
          args.startCol,
          args.endLine,
          args.endCol,
        );
        if (!result.ok) return failResult(result);
        return {
          ok: true as const,
          path: ready.abs,
          language: languageFromPath(ready.abs),
          range: {
            startLine: args.startLine,
            startCol: args.startCol,
            endLine: args.endLine,
            endCol: args.endCol,
          },
          actions: result.value.actions,
          ...(result.value.truncated ? { truncated: true } : {}),
          ...(result.value.skipped ? { skipped: result.value.skipped } : {}),
        };
      },
    }),

    lsp_apply_code_action: defineTool({
      description:
        "Apply a listed code action by id (text edits only; mutating; blocked in plan mode).",
      parameters: z.object({
        id: z.string().min(1).describe("Opaque id from lsp_code_actions"),
      }),
      execute: async (args: { id: string }) => {
        const mgr = ctx.getLsp();
        if (!mgr) return missingManager();
        const result = await mgr.applyCodeAction(args.id, {
          allowPath: (abs) => sandboxBlockReason(abs, ctx.sandbox) === null,
        });
        if (!result.ok) return failResult(result);
        for (const f of result.value.files) {
          if (f.changed) ctx.clearReadPath?.(f.path);
        }
        return { ok: true as const, ...result.value };
      },
    }),
  };
}
