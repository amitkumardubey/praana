/**
 * Post-edit LSP diagnostics / optional format (issue #11 Phase 2).
 *
 * Registered so post-edit runs before write-path lock release.
 */

import { isAbsolute, resolve } from "node:path";
import type { LspManager } from "../../lsp/manager.js";
import { diffIntroduced } from "../../lsp/manager.js";
import { languageFromPath } from "../../lsp/language.js";
import type { LspDiagnostic } from "../../lsp/types.js";
import type {
  PostToolCallHandler,
  PreToolCallHandler,
} from "../types.js";

const EDIT_TOOLS = new Set(["edit_file", "batch_edit"]);

function resolvePath(cwd: string, relPath: string): string {
  return isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
}

function pathsFromArgs(
  cwd: string,
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (toolName === "edit_file" && typeof args.path === "string") {
    return [resolvePath(cwd, args.path)];
  }
  if (toolName === "batch_edit" && Array.isArray(args.edits)) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const edit of args.edits) {
      if (
        edit &&
        typeof edit === "object" &&
        typeof (edit as { path?: unknown }).path === "string"
      ) {
        const abs = resolvePath(cwd, (edit as { path: string }).path);
        if (!seen.has(abs)) {
          seen.add(abs);
          out.push(abs);
        }
      }
    }
    return out;
  }
  return [];
}

function capDiags(diags: LspDiagnostic[]): LspDiagnostic[] {
  return diags.slice(0, 50);
}

export interface LspHookOptions {
  getLsp: () => LspManager | null;
  cwd: string;
  onFormattedPath?: (absPath: string) => void;
}

/** Register paired pre/post handlers that share the snapshot map. */
export function createLspEditHandlers(opts: LspHookOptions): {
  pre: PreToolCallHandler;
  post: PostToolCallHandler;
} {
  const snapshots = new Map<string, LspDiagnostic[]>();

  const pre: PreToolCallHandler = async (ctx) => {
    if (!EDIT_TOOLS.has(ctx.toolName)) return;
    const mgr = opts.getLsp();
    if (!mgr?.enabled || !mgr.diagnosticsEnabled) return;

    for (const abs of pathsFromArgs(opts.cwd, ctx.toolName, ctx.args)) {
      if (!languageFromPath(abs)) continue;
      try {
        snapshots.set(abs, await mgr.snapshotDiagnostics(abs));
      } catch {
        snapshots.set(abs, []);
      }
    }
  };

  const post: PostToolCallHandler = async (ctx) => {
    if (!EDIT_TOOLS.has(ctx.toolName)) return;
    const paths = pathsFromArgs(opts.cwd, ctx.toolName, ctx.args);

    const clearSnaps = () => {
      for (const p of paths) snapshots.delete(p);
    };

    if (ctx.isError || !ctx.result || typeof ctx.result !== "object") {
      clearSnaps();
      return;
    }
    const result = ctx.result as Record<string, unknown>;
    if (result.ok !== true) {
      clearSnaps();
      return;
    }

    const mgr = opts.getLsp();
    if (!mgr?.enabled) {
      clearSnaps();
      return;
    }

    const lspPayload: Record<string, unknown> = {};
    const afterAll: LspDiagnostic[] = [];
    const introducedAll: LspDiagnostic[] = [];
    const warnings: string[] = [];

    for (const abs of paths) {
      if (!languageFromPath(abs)) continue;
      const before = snapshots.get(abs) ?? [];

      if (mgr.formatOnEdit) {
        try {
          const fmt = await mgr.format(abs);
          if (fmt.ok) {
            if (fmt.value.changed) {
              lspPayload.formatted = true;
              opts.onFormattedPath?.(abs);
            } else if (fmt.value.skipped) {
              lspPayload.format_skipped = fmt.value.skipped;
            }
          } else {
            warnings.push(`format: ${fmt.error}`);
          }
        } catch (e) {
          warnings.push(
            `format: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      if (mgr.diagnosticsEnabled) {
        try {
          const afterResult = await mgr.diagnostics(abs);
          if (afterResult.ok) {
            const after = afterResult.value;
            afterAll.push(...after);
            introducedAll.push(...diffIntroduced(before, after));
          } else {
            warnings.push(`diagnostics: ${afterResult.error}`);
          }
        } catch (e) {
          warnings.push(
            `diagnostics: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    clearSnaps();

    if (mgr.diagnosticsEnabled) {
      lspPayload.diagnostics = capDiags(afterAll);
      lspPayload.introduced = capDiags(introducedAll);
    }
    if (warnings.length > 0) {
      lspPayload.warning = warnings.join("; ");
    }

    if (Object.keys(lspPayload).length === 0) return;

    return {
      result: {
        ...result,
        lsp: lspPayload,
      },
    };
  };

  return { pre, post };
}
