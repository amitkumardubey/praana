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

export function createLspTools(ctx: LspToolsContext) {
  return {
    lsp_diagnostics: defineTool({
      description:
        "Return LSP diagnostics for a source file (TypeScript/JavaScript when a server is configured). Soft-fails when LSP is disabled or unavailable.",
      parameters: z.object({
        path: pathSchema,
      }),
      execute: async (args: { path: string }) => {
        const mgr = ctx.getLsp();
        if (!mgr) {
          return {
            ok: false as const,
            error: "LSP unavailable: manager not initialized",
            code: "unavailable",
          };
        }
        const abs = resolveUserPath(ctx.cwd, args.path);
        const pathErr = ensureFilePath(abs, ctx.sandbox);
        if (pathErr) return pathErr;
        const result = await mgr.diagnostics(abs);
        if (!result.ok) {
          return {
            ok: false as const,
            error: result.error,
            code: result.code,
          };
        }
        return {
          ok: true as const,
          path: abs,
          language: languageFromPath(abs),
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
        const mgr = ctx.getLsp();
        if (!mgr) {
          return {
            ok: false as const,
            error: "LSP unavailable: manager not initialized",
            code: "unavailable",
          };
        }
        const abs = resolveUserPath(ctx.cwd, args.path);
        const pathErr = ensureFilePath(abs, ctx.sandbox);
        if (pathErr) return pathErr;
        const result = await mgr.format(abs);
        if (!result.ok) {
          return {
            ok: false as const,
            error: result.error,
            code: result.code,
          };
        }
        if (result.value.changed) {
          ctx.clearReadPath?.(abs);
        }
        return {
          ok: true as const,
          path: abs,
          language: languageFromPath(abs),
          changed: result.value.changed,
          ...(result.value.skipped
            ? { skipped: result.value.skipped }
            : {}),
        };
      },
    }),
  };
}
