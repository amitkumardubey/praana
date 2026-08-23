/**
 * Post-edit verification: syntax, scoped tsc, test-impact (issue #299).
 *
 * Registered after LSP post-edit and before write-path lock release.
 */

import { extname, isAbsolute, resolve } from "node:path";
import { tryGetNative } from "../../native/index.js";
import type { VerifyConfig } from "../../types.js";
import { VerifyHashCache } from "../../verify/cache.js";
import { ImportGraphCache, type ListImportsFn } from "../../verify/import-graph.js";
import { checkSyntax, type ParseFileFn } from "../../verify/syntax.js";
import { runAffectedTestsForPaths, type RunTestsFn } from "../../verify/test-impact.js";
import {
  checkTypecheck,
  defaultRunTypecheck,
  findTsconfigDir,
  type RunTypecheckFn,
} from "../../verify/typecheck.js";
import { VERIFY_DIAG_CAP, VERIFY_TSC_CAP, type VerifyPayload } from "../../verify/types.js";
import type { PostToolCallHandler } from "../types.js";

const VERIFY_TOOLS = new Set([
  "write_file",
  "edit_file",
  "batch_write",
  "batch_edit",
]);

const TS_EXT = new Set([".ts", ".tsx", ".mts", ".cts"]);

function resolvePath(cwd: string, relPath: string): string {
  return isAbsolute(relPath) ? relPath : resolve(cwd, relPath);
}

export function pathsFromVerifyArgs(
  cwd: string,
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const abs = resolvePath(cwd, raw);
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  };

  if (
    (toolName === "write_file" || toolName === "edit_file") &&
    typeof args.path === "string"
  ) {
    add(args.path);
    return out;
  }
  if (toolName === "batch_write" && Array.isArray(args.files)) {
    for (const file of args.files) {
      if (file && typeof file === "object") {
        add((file as { path?: unknown }).path);
      }
    }
    return out;
  }
  if (toolName === "batch_edit" && Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (edit && typeof edit === "object") {
        add((edit as { path?: unknown }).path);
      }
    }
    return out;
  }
  return out;
}

const CLEAN_TYPECHECK_SKIP = new Set(["no_tsconfig", "unsupported"]);
const CLEAN_TEST_SKIP = new Set(["none_affected"]);
const INCOMPLETE_SKIP = new Set([
  "timeout",
  "spawn_error",
  "no_runner",
  "unparsed",
  "parse_error",
]);

/** Remember only a complete verify: no errors, and skips that are expected absences. */
export function shouldRemember(payload: VerifyPayload): boolean {
  if ((payload.syntax?.diagnostics.length ?? 0) > 0) return false;
  if (payload.syntax?.skipped) return false;
  if ((payload.typecheck?.errors.length ?? 0) > 0) return false;
  if (
    payload.typecheck?.skipped &&
    !CLEAN_TYPECHECK_SKIP.has(payload.typecheck.skipped)
  ) {
    return false;
  }
  const tests = payload.tests;
  if (!tests) return true;
  if (tests.skipped) return CLEAN_TEST_SKIP.has(tests.skipped);
  return (tests.failed ?? 0) === 0;
}

export interface VerifyHookOptions {
  cwd: string;
  sessionRoot?: string;
  getConfig: () => VerifyConfig | undefined;
  cache?: VerifyHashCache;
  graphCache?: ImportGraphCache;
  parseFile?: ParseFileFn | null;
  listImports?: ListImportsFn | null;
  runTypecheck?: RunTypecheckFn;
  runTests?: RunTestsFn;
}

export function createVerifyPostToolCallHandler(
  opts: VerifyHookOptions,
): PostToolCallHandler {
  const cache = opts.cache ?? new VerifyHashCache();
  const graphCache = opts.graphCache ?? new ImportGraphCache();

  return async (ctx) => {
    if (!VERIFY_TOOLS.has(ctx.toolName)) return;
    const cfg = opts.getConfig();
    if (!cfg?.enabled) return;
    if (ctx.isError || !ctx.result || typeof ctx.result !== "object") return;

    const result = ctx.result as Record<string, unknown>;
    if (result.ok !== true) return;

    const paths = pathsFromVerifyArgs(opts.cwd, ctx.toolName, ctx.args);
    if (paths.length === 0) return;

    const sessionRoot = opts.sessionRoot ?? opts.cwd;
    const payload = await runVerify(paths, sessionRoot, cfg, {
      cache,
      graphCache,
      parseFile: opts.parseFile,
      listImports: opts.listImports,
      runTypecheck: opts.runTypecheck,
      runTests: opts.runTests,
    });

    return {
      result: {
        ...result,
        verify: payload,
      },
    };
  };
}

async function resolveParseFile(
  injected: ParseFileFn | null | undefined,
): Promise<ParseFileFn | null> {
  if (injected !== undefined) return injected;
  const native = await tryGetNative();
  return native?.parseFile ?? null;
}

async function resolveListImports(
  injected: ListImportsFn | null | undefined,
): Promise<ListImportsFn | null> {
  if (injected !== undefined) return injected;
  const native = await tryGetNative();
  return native?.listImports ?? null;
}

async function runVerify(
  paths: string[],
  sessionRoot: string,
  cfg: VerifyConfig,
  deps: {
    cache: VerifyHashCache;
    graphCache: ImportGraphCache;
    parseFile?: ParseFileFn | null;
    listImports?: ListImportsFn | null;
    runTypecheck?: RunTypecheckFn;
    runTests?: RunTestsFn;
  },
): Promise<VerifyPayload> {
  if (paths.every((p) => deps.cache.isFresh(p))) {
    return { cached: true };
  }

  const payload: VerifyPayload = {};
  let hasErrors = false;

  if (cfg.syntax) {
    const parseFile = await resolveParseFile(deps.parseFile);
    const diagnostics = [];
    let skipped: string | undefined;
    for (const path of paths) {
      const syntax = await checkSyntax(path, { parseFile });
      diagnostics.push(...syntax.diagnostics);
      if (syntax.skipped) skipped = syntax.skipped;
    }
    payload.syntax = {
      diagnostics: diagnostics.slice(0, VERIFY_DIAG_CAP),
      ...(skipped ? { skipped } : {}),
    };
    if (payload.syntax.diagnostics.length > 0) hasErrors = true;
  }

  if (cfg.typecheck) {
    const errors = [];
    let skipped: string | undefined;
    const seenProjects = new Set<string>();
    for (const path of paths) {
      if (TS_EXT.has(extname(path).toLowerCase())) {
        const projectDir = findTsconfigDir(path, sessionRoot);
        if (projectDir) {
          if (seenProjects.has(projectDir)) continue;
          seenProjects.add(projectDir);
        }
      }
      const tsc = await checkTypecheck(path, sessionRoot, {
        runTypecheck: deps.runTypecheck ?? defaultRunTypecheck,
        timeoutMs: cfg.timeout_ms,
      });
      errors.push(...tsc.errors);
      if (tsc.skipped) skipped = tsc.skipped;
    }
    payload.typecheck = {
      errors: errors.slice(0, VERIFY_TSC_CAP),
      ...(skipped ? { skipped } : {}),
    };
    if (payload.typecheck.errors.length > 0) hasErrors = true;
  }

  if (cfg.tests) {
    const incomplete =
      (payload.syntax?.skipped && INCOMPLETE_SKIP.has(payload.syntax.skipped)
        ? payload.syntax.skipped
        : undefined) ??
      (payload.typecheck?.skipped &&
      INCOMPLETE_SKIP.has(payload.typecheck.skipped)
        ? payload.typecheck.skipped
        : undefined);
    if (hasErrors) {
      payload.tests = { skipped: "errors_present" };
    } else if (incomplete) {
      payload.tests = { skipped: incomplete };
    } else {
      payload.tests = await runAffectedTestsForPaths(paths, sessionRoot, {
        listImports: await resolveListImports(deps.listImports),
        runTests: deps.runTests,
        graphCache: deps.graphCache,
        maxTestFiles: cfg.max_test_files,
        timeoutMs: cfg.timeout_ms,
      });
    }
  }

  if (shouldRemember(payload)) {
    for (const path of paths) deps.cache.remember(path);
  }
  return payload;
}
