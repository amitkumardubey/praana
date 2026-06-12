import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve as resolvePath, isAbsolute, normalize } from "node:path";
import { homedir } from "node:os";
import type { SandboxConfig } from "../types.js";

/**
 * search_code — ripgrep-backed structured code search.
 *
 * Wraps `rg --json` with a stable JSON contract the model can consume:
 *   { matches: [{ file, line, column, text, context_before, context_after }],
 *     stats:   { totalMatches, filesWithMatches, truncated } }
 *
 * rg is resolved from the inherited PATH by default; an override is accepted
 * for tests and packaged-binary scenarios.
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
  /** Minimum number of matches dropped due to `max_results`. 0 when not truncated. */
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
  /** Override ripgrep binary path (default: "rg" via PATH lookup). */
  rgPath?: string;
}

const searchCodeSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe("Regex pattern to search for (ripgrep regex syntax)"),
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
    .describe("Case-insensitive search (-i)"),
  context: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Lines of context before and after each match (-C). Default 0."),
  max_results: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Stop after this many matches are found"),
  file_type: z
    .string()
    .optional()
    .describe("ripgrep file type filter (e.g. 'ts', 'rust', 'py')"),
  include_hidden: z
    .boolean()
    .optional()
    .describe("Search hidden files and directories (--hidden)"),
  no_ignore: z
    .boolean()
    .optional()
    .describe("Don't respect .gitignore/.ignore (--no-ignore)"),
  multiline: z
    .boolean()
    .optional()
    .describe("Allow patterns to match across multiple lines (-U)"),
  timeout: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Timeout in milliseconds (default 30000)"),
});

export type SearchCodeArgs = z.infer<typeof searchCodeSchema>;

/**
 * Build the ripgrep argv for the given arguments.
 *
 * Pattern is passed as `--` then `pattern` so it can't be misinterpreted as
 * a flag even if it starts with `-`.
 */
export function buildRipgrepArgs(args: SearchCodeArgs, searchPath: string): string[] {
  const argv: string[] = [
    "--json",
    "--no-heading",
    "--no-messages",
    // --no-config: ignore the user's ~/.ripgreprc / RIPGREP_CONFIG_PATH so the
    // tool's behavior is deterministic across machines. Custom ripgrep configs
    // (e.g. --type-add) are NOT honored by this tool.
    "--no-config",
  ];

  if (args.case_insensitive) argv.push("-i");
  if (args.multiline) argv.push("-U");
  if (args.include_hidden) argv.push("--hidden");
  if (args.no_ignore) argv.push("--no-ignore");
  if (args.file_type) argv.push("--type", args.file_type);
  const ctx = args.context ?? 0;
  if (ctx > 0) argv.push("-C", String(ctx));

  for (const g of args.glob ? (Array.isArray(args.glob) ? args.glob : [args.glob]) : []) {
    argv.push("--glob", g);
  }
  for (const g of args.glob_exclude
    ? Array.isArray(args.glob_exclude)
      ? args.glob_exclude
      : [args.glob_exclude]
    : []) {
    argv.push("--glob", "!" + g);
  }

  argv.push("--", args.pattern, searchPath);
  return argv;
}

/** Return null if the path is allowed by the sandbox, else a human-readable error. */
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

// ---- JSON event types from rg --json ----

interface RgSubmatch {
  match: { text: string };
  start: number;
  end: number;
}

interface RgEventData {
  path?: { text: string };
  lines?: { text: string };
  line_number?: number;
  absolute_offset?: number;
  submatches?: RgSubmatch[];
  stats?: {
    matches?: number;
    matched_lines?: number;
    searches_with_match?: number;
  };
}

interface RgEvent {
  type: "begin" | "end" | "match" | "context" | "summary";
  data: RgEventData;
}

/**
 * Streaming ripgrep-JSON parser.
 *
 * The parser holds mutable state (matches array, per-file context map, last
 * match in file) that the caller can feed events into incrementally. This
 * lets `runRipgrep` parse as bytes arrive from rg's stdout rather than
 * buffering every event in a `string[]` until the child closes — which
 * previously grew linearly with match count and OOM'd on broad searches.
 *
 * Context events are accumulated into a per-file line map. For each match,
 * the lines with `line_number ∈ [match.line - context, match.line + context]`
 * populate `context_before` / `context_after`. The last match's "after"
 * context is back-filled on the file's `end` event so trailing context
 * lines aren't lost.
 */
export interface ParseState {
  matches: SearchCodeMatch[];
  totalMatches: number;
  truncated: boolean;
  // Private — do not mutate from outside.
  _currentFile: string | null;
  _currentFileLineMap: Map<number, string>;
  _lastMatchInFile: SearchCodeMatch | null;
}

export function createParseState(): ParseState {
  return {
    matches: [],
    totalMatches: 0,
    truncated: false,
    _currentFile: null,
    _currentFileLineMap: new Map(),
    _lastMatchInFile: null,
  };
}

function processEvent(
  state: ParseState,
  ev: RgEvent,
  context: number,
  maxResults: number | undefined,
  onTruncate: () => void,
): void {
  if (ev.type === "begin") {
    state._currentFile = ev.data.path?.text ?? null;
    state._currentFileLineMap = new Map();
    state._lastMatchInFile = null;
    return;
  }

  if (ev.type === "end") {
    if (state._lastMatchInFile && context > 0 && state._currentFile) {
      const after: string[] = [];
      for (let i = 1; i <= context; i++) {
        const t = state._currentFileLineMap.get(state._lastMatchInFile.line + i);
        if (t !== undefined) after.push(t);
      }
      state._lastMatchInFile.context_after = after;
    }
    return;
  }

  if (ev.type === "context") {
    const ln = ev.data.line_number;
    const text = ev.data.lines?.text ?? "";
    if (ln !== undefined) {
      const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
      state._currentFileLineMap.set(ln, trimmed);

      if (
        state._lastMatchInFile &&
        context > 0 &&
        ln > state._lastMatchInFile.line &&
        ln <= state._lastMatchInFile.line + context
      ) {
        state._lastMatchInFile.context_after.push(trimmed);
      }
    }
    return;
  }

  if (ev.type === "match") {
    if (state.truncated) return;
    if (maxResults !== undefined && state.totalMatches >= maxResults) {
      state.truncated = true;
      onTruncate();
      return;
    }

    const file = ev.data.path?.text ?? "";
    const line = ev.data.line_number ?? 0;
    const sub = ev.data.submatches?.[0];
    const column = (sub?.start ?? 0) + 1;
    const rawText = ev.data.lines?.text ?? "";
    const text = rawText.endsWith("\n") ? rawText.slice(0, -1) : rawText;

    const before: string[] = [];
    if (context > 0) {
      for (let i = context; i >= 1; i--) {
        const t = state._currentFileLineMap.get(line - i);
        if (t !== undefined) before.push(t);
      }
    }

    const m: SearchCodeMatch = {
      file,
      line,
      column,
      text,
      context_before: before,
      context_after: [],
    };
    state.matches.push(m);
    state._lastMatchInFile = m;
    state.totalMatches++;
    return;
  }
}

/** Feed raw rg --json lines into the parse state. Triggers `onTruncate` on cap. */
export function feedParseState(
  state: ParseState,
  rawLines: string[],
  context: number,
  maxResults: number | undefined,
  onTruncate: () => void,
): void {
  for (const raw of rawLines) {
    if (state.truncated) break;
    if (!raw) continue;
    let ev: RgEvent;
    try {
      ev = JSON.parse(raw) as RgEvent;
    } catch {
      // Malformed line — rg should not produce these, skip defensively.
      continue;
    }
    processEvent(state, ev, context, maxResults, onTruncate);
  }
}

/** Convenience wrapper: feed a complete log at once. Used by tests. */
export function parseRipgrepEvents(
  rawLines: string[],
  context: number,
  maxResults: number | undefined,
  onTruncate: () => void,
): {
  matches: SearchCodeMatch[];
  totalMatches: number;
  filesWithMatches: number;
  truncated: boolean;
} {
  const state = createParseState();
  feedParseState(state, rawLines, context, maxResults, onTruncate);
  const filesWithMatches = new Set(state.matches.map((m) => m.file)).size;
  return {
    matches: state.matches,
    totalMatches: state.totalMatches,
    filesWithMatches,
    truncated: state.truncated,
  };
}

/** Spawn ripgrep, return structured result. */
export async function runRipgrep(
  args: SearchCodeArgs,
  rgBin: string,
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

  const argv = buildRipgrepArgs(args, searchPath);
  const ctx = args.context ?? 0;
  const maxResults = args.max_results;
  const timeoutMs = args.timeout ?? 30_000;
  const signal = getAbortSignal?.();

  if (signal?.aborted) return { ok: false, error: "Interrupted" };

  return new Promise<SearchCodeResult>((resolve) => {
    const child = spawn(rgBin, argv, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Node 22 resolves a bare "rg" against PATH on POSIX.
    });

    let stdoutBuf = "";
    let resolved = false;
    const stderrChunks: Buffer[] = [];
    const state = createParseState();

    const kill = (sig: NodeJS.Signals) => {
      if (!child.killed) child.kill(sig);
    };

    /** Stop the child and drop the stdout pipe so no more bytes enter the buffer. */
    const truncateNow = () => {
      child.stdout?.destroy();
      // SIGKILL is the right signal here: we no longer care about rg's
      // cleanup, only that it stops writing to the pipe.
      kill("SIGKILL");
    };

    const finish = (result: SearchCodeResult) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 500).unref();
      resolve(result);
    };

    const onAbort = () => finish({ ok: false, error: "Interrupted" });
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      finish({ ok: false, error: `search_code timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (state.truncated) return; // backpressure: stop buffering post-cap bytes
      stdoutBuf += chunk.toString("utf-8");
      let nl: number;
      const newLines: string[] = [];
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        newLines.push(stdoutBuf.slice(0, nl));
        stdoutBuf = stdoutBuf.slice(nl + 1);
      }
      if (newLines.length > 0) {
        feedParseState(state, newLines, ctx, maxResults, truncateNow);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (stderrChunks.length > 64) stderrChunks.shift();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        finish({
          ok: false,
          error:
            "ripgrep ('rg') not found in PATH. Install ripgrep (https://github.com/BurntSushi/ripgrep) or set search_code.rg_path in aria.config.toml to point at the binary.",
        });
        return;
      }
      finish({ ok: false, error: `Failed to run ripgrep: ${err.message}` });
    });

    child.on("close", (code) => {
      if (resolved) {
        // finish() already ran (abort / timeout / error). Drop any tail bytes.
        stdoutBuf = "";
        return;
      }
      if (stdoutBuf.length > 0) {
        feedParseState(state, [stdoutBuf], ctx, maxResults, truncateNow);
        stdoutBuf = "";
      }

      const stderrTail = Buffer.concat(stderrChunks).toString("utf-8").trim();
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (code === 2) {
        finish({
          ok: false,
          error: stderrTail
            ? `ripgrep error: ${stderrTail}`
            : "ripgrep exited with code 2 (regex parse error or other failure)",
        });
        return;
      }

      if (code === 0 || code === 1 || state.matches.length > 0) {
        const filesWithMatches = new Set(state.matches.map((m) => m.file)).size;
        finish({
          ok: true,
          pattern: args.pattern,
          path: searchPath,
          matches: state.matches,
          stats: {
            totalMatches: state.totalMatches,
            filesWithMatches,
            truncated: state.truncated,
            dropped: state.truncated ? 1 : 0, // exact count unknown; >= 1
          },
          duration_ms: Date.now() - started,
        });
        return;
      }

      finish({
        ok: false,
        error: stderrTail
          ? `ripgrep failed: ${stderrTail}`
          : `ripgrep exited with code ${code}`,
      });
    });
  });
}

export function createSearchCodeTool(ctx: SearchCodeToolContext) {
  return {
    search_code: defineTool({
      description:
        "Fast structured code search powered by ripgrep. Returns file:line:column matches with optional context lines. Use instead of `shell grep` for codebase exploration.",
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
        return runRipgrep(
          parsed.data,
          ctx.rgPath ?? "rg",
          ctx.cwd,
          ctx.sandbox,
          ctx.getAbortSignal,
        );
      },
    }),
  };
}
