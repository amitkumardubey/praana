import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve, isAbsolute, extname, normalize, relative } from "node:path";
import { homedir } from "node:os";
import { parseToml } from "../toml-parse.js";
import type { SandboxConfig } from "../types.js";
import { pathInRoot } from "../path-containment.js";
import type { SkillRecord } from "../skills/types.js";
import type { SkillRuntime } from "../skills/index.js";
import type { ScorecardInc } from "../context-engine/telemetry.js";
import { estimateTokens } from "../token-estimate.js";
import {
  actionRefusalError,
  type ActionConfirmHandler,
  type PreviewLine,
} from "../confirm/action.js";
import { detectShellReads } from "./shell-read-detect.js";
import { buildPathChurnHint } from "./read-churn.js";
import { sanitizeChildEnv } from "./sanitize-child-env.js";

/**
 * Validate content for known structured formats.
 * Returns a warning string if the content looks malformed, or null if fine.
 */
function validateStructuredContent(filePath: string, content: string): string | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".json") {
    try { JSON.parse(content); } catch (e: any) {
      return `Warning: content does not parse as valid JSON (${e.message}). File written anyway.`;
    }
  }
  if (ext === ".toml") {
    try { parseToml(content); } catch (e: any) {
      return `Warning: content does not parse as valid TOML (${e.message}). File written anyway.`;
    }
  }
  return null;
}

export interface SystemToolContext {
  cwd: string;
  getAbortSignal?: () => AbortSignal | undefined;
  sandbox?: SandboxConfig;
  editConfirm?: boolean;
  /**
   * Ask the session to confirm `edit_file` (#748). Supplied by `turn.ts`; the
   * tool never reads stdin itself, because in the TUI OpenTUI owns it.
   */
  confirmAction?: ActionConfirmHandler;
  shellLiveStream?: boolean;
  skills: SkillRecord[];
  skillRuntime: SkillRuntime | null;
  skillScorecard?: ScorecardInc;
  onScorecardFileRead?: (absPath: string, mtimeMs?: number, countAsRepeat?: boolean) => void;
  onScorecardSkillLoad?: (skillId: string, bodyTokens: number) => void;
  getCurrentTurn: () => number;
  /** mtime from last successful read; used to detect external edits. */
  getReadPathMtime?: (absPath: string) => number | undefined;
  clearReadPath?: (absPath: string) => void;
  /**
   * Context window of the model running this turn, in tokens (#811). `read_file`
   * sizes its per-call output cap from it; unknown means the fallback window.
   */
  getContextWindowTokens?: () => number | undefined;
}

/** Lines a single `read_file` call returns at most (#811). */
export const MAX_READ_LINES = 2000;
/** A returned line longer than this is cut, so a minified file cannot be one huge line (#811). */
export const MAX_LINE_CHARS = 2000;
/** Share of the model's context window one `read_file` call may spend in estimated tokens (#811). */
const READ_TOKEN_WINDOW_RATIO = 0.25;
/** Window assumed when the model's context window is unknown (#811): 25% of 100k = 25k tokens. */
const FALLBACK_CONTEXT_WINDOW_TOKENS = 100_000;

export interface ShellRunOptions {
  command: string;
  cwd: string;
  sandbox?: SandboxConfig;
  timeout?: number;
  abortSignal?: AbortSignal;
  onStdout?(chunk: Buffer): void;
  onStderr?(chunk: Buffer): void;
}

export interface ShellRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function executeShellCommand(
  opts: ShellRunOptions,
): Promise<ShellRunResult> {
  const { command, cwd, sandbox, timeout, abortSignal, onStdout, onStderr } = opts;

  if (abortSignal?.aborted) {
    return { ok: false, stdout: "", stderr: "Interrupted", exitCode: 130 };
  }

  // Sandbox validation
  if (sandbox?.enabled) {
    const dangerousPatterns = [
      /\bsudo\b/,
      /\brm\b.*-r.*\//,
      /\brm\b.*-f.*\//,
      /\bmkfs\b/,
      /\bdd\b.*if=/,
      /\bdd\b.*of=/,
      /\bshutdown\b/,
      /\breboot\b/,
      /\bhalt\b/,
      /\bpoweroff\b/,
      /\bfdisk\b/,
      /\bparted\b/,
      /\bwipefs\b/,
      /\bcryptsetup\b/,
      /\bchmod\b.*-R.*777.*\//,
      /\bchown\b.*-R.*\//,
      />\s*\/dev\/sd[a-z]/,
      /:\(\)\{\s*:\|\&\s*\};/,
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return {
          ok: false,
          stdout: "",
          stderr: "Blocked by sandbox: dangerous command detected",
          exitCode: 1,
        };
      }
    }
    if (sandbox.allowed_paths.length > 0) {
      const pathPattern = /(?:["']([^"']+)["']|(\/[\w.\/-]+|\~\/[\w.\/-]+))/g;
      let match: RegExpExecArray | null;
      while ((match = pathPattern.exec(command)) !== null) {
        const rawPath = match[1] ?? match[2];
        if (!rawPath) continue;
        const expanded = rawPath.replace(/^~/, homedir());
        const normalized = normalize(expanded);
        let resolved: string;
        try {
          resolved = existsSync(normalized) ? realpathSync(normalized) : normalized;
        } catch {
          resolved = normalized;
        }
        const isAllowed = sandbox.allowed_paths.some((ap) => {
          const apExpanded = ap.replace(/^~/, homedir());
          const apNormalized = normalize(apExpanded);
          let apResolved: string;
          try {
            apResolved = existsSync(apNormalized) ? realpathSync(apNormalized) : apNormalized;
          } catch {
            apResolved = apNormalized;
          }
          return pathInRoot(resolved, apResolved);
        });
        if (!isAllowed) {
          return {
            ok: false,
            stdout: "",
            stderr: `Blocked by sandbox: path not in allowed list: ${rawPath}`,
            exitCode: 1,
          };
        }
      }
    }
  }

  const ms = timeout ?? 30000;
  /** After SIGTERM, escalate to SIGKILL + force-resolve so a stuck child can't hang the tool. */
  const FORCE_SETTLE_MS = 1000;

  return new Promise((resolve) => {
    // detached: new process group so timeout/abort can signal the whole tree
    // (bash + find/sleep/etc). Without this, killing bash alone leaves children
    // holding stdout/stderr open and the Promise never settles (seen with find /).
    const child = spawn(command, [], {
      cwd,
      shell: "/bin/bash",
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      env: sanitizeChildEnv(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const maxBuf = 10 * 1024 * 1024;

    const finish = (result: ShellRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const killTree = (signal: NodeJS.Signals) => {
      if (child.pid == null) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Process group may already be gone; fall through to direct kill.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // already dead
      }
    };

    const destroyStdio = () => {
      try {
        child.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.stderr?.destroy();
      } catch {
        /* ignore */
      }
    };

    /** SIGTERM the tree, then SIGKILL + force-finish if close never arrives. */
    const terminate = (reason: "timeout" | "abort") => {
      killTree("SIGTERM");
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        killTree("SIGKILL");
        destroyStdio();
        if (reason === "abort" || abortSignal?.aborted) {
          finish({
            ok: false,
            stdout: stdout.slice(0, maxBuf),
            stderr: stderr.slice(0, maxBuf) || "Interrupted",
            exitCode: 130,
          });
        } else {
          finish({
            ok: false,
            stdout: stdout.slice(0, maxBuf),
            stderr: stderr.slice(0, maxBuf) || `Timed out after ${ms}ms`,
            exitCode: 124,
          });
        }
      }, FORCE_SETTLE_MS);
    };

    const onAbort = () => {
      terminate("abort");
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      terminate("timeout");
    }, ms);

    child.stdout?.on("data", (chunk: Buffer) => {
      onStdout?.(chunk);
      if (stdout.length < maxBuf) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      onStderr?.(chunk);
      if (stderr.length < maxBuf) stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (abortSignal?.aborted) {
        finish({
          ok: false,
          stdout: stdout.slice(0, maxBuf),
          stderr: stderr.slice(0, maxBuf) || "Interrupted",
          exitCode: 130,
        });
        return;
      }
      if (timedOut) {
        finish({
          ok: false,
          stdout: stdout.slice(0, maxBuf),
          stderr: stderr.slice(0, maxBuf) || `Timed out after ${ms}ms`,
          exitCode: code ?? 124,
        });
        return;
      }
      finish({
        ok: code === 0,
        stdout: stdout.slice(0, maxBuf),
        stderr: stderr.slice(0, maxBuf),
        exitCode: code ?? 1,
      });
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        stdout,
        stderr: err.message,
        exitCode: 1,
      });
    });
  });
}

export interface CappedReadResult {
  ok: true;
  /** Pure file lines; engine mode stores this verbatim as the lossless artifact. */
  content: string;
  /** Line count of the whole file (see the line model in the body). */
  total_lines: number;
  /**
   * File lines actually present in `content`, 0 when the result is empty.
   *
   * This is the only exact answer: `content` alone cannot tell a read whose last
   * returned line is blank (so it ends with `\n`) from the re-attached
   * file-final newline, and the artifact line range depends on it (#811).
   */
  returned_lines: number;
  /** Present only when the cap cut lines or long lines were cut. */
  truncated?: true;
  /** How to read the next part (never part of `content`). */
  note?: string;
}

/**
 * Cut a line longer than MAX_LINE_CHARS and mark it.
 *
 * A UTF-16 surrogate pair must not be split, so when the last kept code unit is
 * a high surrogate (the first half of a pair such as an emoji) it is dropped.
 */
function cutLongLine(line: string): string {
  let end = MAX_LINE_CHARS;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${line.slice(0, end)} … [line truncated, ${line.length} chars]`;
}

/**
 * Build the `read_file` result for `content`, capped per call (#811).
 *
 * Line model: `content.split("\n")` is the paging space that `offset`/`limit`
 * index into, but the empty segment a trailing newline leaves behind is dropped,
 * so `total_lines` and `note` report the real line count instead of a phantom
 * extra line. The trailing newline is re-attached when the read reaches the last
 * line, which keeps a whole read byte-identical to the older `lines.join("\n")`
 * result. `truncated` means the per-call cap cut content, not a `limit` that the
 * model asked for.
 */
export function buildCappedReadResult(
  content: string,
  opts: { offset?: number; limit?: number; contextWindowTokens?: number },
): CappedReadResult {
  const fileLines = content === "" ? [] : content.split("\n");
  const endsWithNewline = content.length > 0 && content.endsWith("\n");
  if (endsWithNewline) fileLines.pop();
  const totalLines = fileLines.length;
  const startIndex = Math.max(0, (opts.offset ?? 1) - 1);

  // An explicit `limit` bounds the read. The per-call cap below is applied while
  // lines are considered, so a line past the cap is never cut, measured or
  // counted — a file whose long line lies past the cap must not claim it cut one.
  const available = Math.max(
    0,
    opts.limit !== undefined
      ? Math.min(opts.limit, fileLines.length - startIndex)
      : fileLines.length - startIndex,
  );

  // The per-call cap: the smaller of MAX_READ_LINES and a quarter of the model's
  // context window in estimated tokens. Always keep at least one line, even when
  // that single line alone exceeds the token limit.
  const contextWindowTokens = opts.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
  const tokenLimit = Math.floor(contextWindowTokens * READ_TOKEN_WINDOW_RATIO);
  const selected: string[] = [];
  let longLinesCut = 0;
  let tokens = 0;
  for (let index = startIndex; index < fileLines.length && selected.length < available; index++) {
    if (selected.length >= MAX_READ_LINES) break;
    const rawLine = fileLines[index]!;
    // Cut before estimating, so the token cap measures what is returned.
    const isLong = rawLine.length > MAX_LINE_CHARS;
    const line = isLong ? cutLongLine(rawLine) : rawLine;
    const lineTokens = estimateTokens(line) + (selected.length > 0 ? 1 : 0); // 1 ≈ separator newline
    if (selected.length > 0 && tokens + lineTokens > tokenLimit) break;
    tokens += lineTokens;
    selected.push(line);
    if (isLong) longLinesCut++;
  }
  const capCut = selected.length < available;

  const reachedEnd = startIndex + selected.length >= fileLines.length;
  let outContent = selected.join("\n");
  if (endsWithNewline && selected.length > 0 && reachedEnd) outContent += "\n";

  const result: CappedReadResult = {
    ok: true,
    content: outContent,
    total_lines: totalLines,
    returned_lines: selected.length,
  };
  if (capCut || longLinesCut > 0) {
    const first = startIndex + 1;
    const last = startIndex + selected.length;
    const parts = [`Returned lines ${first}-${last} of ${totalLines}`];
    if (longLinesCut > 0) {
      parts.push(
        `${longLinesCut} line${longLinesCut === 1 ? "" : "s"} cut at ${MAX_LINE_CHARS} characters; ` +
          "the rest of a cut line is not available through read_file, use the shell to read the rest of a cut line",
      );
    }
    if (capCut) parts.push(`call read_file with offset=${last + 1} for the next part`);
    result.truncated = true;
    result.note = parts.join("; ");
  } else if (selected.length === 0 && startIndex > 0) {
    // Not an error, but an empty result on its own reads like a bug to the model.
    result.note = `offset ${opts.offset} is past the end of the file (total_lines ${totalLines})`;
  }
  return result;
}

export function createSystemTools(ctx: SystemToolContext) {
  const {
    cwd,
    getAbortSignal,
    sandbox,
    editConfirm,
    confirmAction,
    shellLiveStream,
    skills,
    skillRuntime,
    skillScorecard,
    onScorecardFileRead,
    onScorecardSkillLoad,
    getCurrentTurn,
    getReadPathMtime,
    clearReadPath,
    getContextWindowTokens,
  } = ctx;

  const resolvePath = (p: string): string => {
    if (isAbsolute(p)) return p;
    return resolve(cwd, p);
  };

  const invalidateReadPath = (absPath: string): void => {
    clearReadPath?.(absPath);
  };

  return {
    shell: defineTool({
      description:
        "Execute a shell command in the working directory. Returns stdout, stderr, and exit code. Do not use it to fetch web pages (curl/wget); use web_fetch.",
      parameters: z.object({
        command: z.string().describe("Shell command to execute"),
        timeout: z
          .number()
          .optional()
          .describe("Timeout in milliseconds (default 30000)"),
      }),
      execute: async ({ command, timeout }) => {
        const signal = getAbortSignal?.();
        if (signal?.aborted) {
          return { ok: false, stdout: "", stderr: "Interrupted", exitCode: 130 };
        }

        const result = await executeShellCommand({
          command,
          cwd,
          sandbox,
          timeout,
          abortSignal: signal,
          onStdout: shellLiveStream !== false
            ? (chunk) => process.stdout.write(chunk)
            : undefined,
          onStderr: shellLiveStream !== false
            ? (chunk) => process.stderr.write(chunk)
            : undefined,
        });

        // Telemetry only — never block, never alter stdout/stderr/exitCode.
        // Detect read-equivalent commands and attach a soft recovery warning
        // when the same path has been accessed repeatedly (issue #571).
        if (result.ok && skillScorecard?.trackFileAccess) {
          const detected = detectShellReads(command);
          if (detected) {
            let warning: string | undefined;
            for (const p of detected.paths) {
              const absPath = resolvePath(p);
              const outcome = skillScorecard.trackFileAccess(absPath, "shell");
              if (outcome.shouldIntervene) {
                const channels = skillScorecard.getFileAccessChannels?.(absPath)
                  ?? ["shell"];
                const display = absPath.startsWith(cwd)
                  ? relative(cwd, absPath) || p
                  : p;
                warning = buildPathChurnHint(display, outcome.count, channels);
              }
            }
            if (warning) return { ...result, warning };
          }
        }

        return result;
      },
    }),

    read_file: defineTool({
      description:
        "Read contents of a file. Supports optional offset and limit for partial reads. " +
        "Re-reading a file always returns its current contents. " +
        "Large files are returned in parts: when the result has `truncated: true`, read the " +
        "`note` and call again with the `offset` it names to get the next part. `total_lines` " +
        "is the line count of the whole file and `returned_lines` the number of lines in this result.",
      parameters: z.object({
        path: z.string().describe("File path (relative to working dir or absolute)"),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Line number to start reading from (1-indexed)"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum lines to read"),
      }),
      execute: async ({ path, offset, limit }) => {
        const absPath = resolvePath(path);
        try {
          if (!existsSync(absPath)) {
            return { ok: false, error: `File not found: ${path}` };
          }

          const mtimeMs = statSync(absPath).mtimeMs;
          // Telemetry only: a repeat read still counts, but the file always comes from disk.
          const priorMtime = getReadPathMtime?.(absPath);
          const unchanged = priorMtime !== undefined && priorMtime === mtimeMs;
          const content = readFileSync(absPath, "utf-8");
          const capped = buildCappedReadResult(content, {
            offset,
            limit,
            contextWindowTokens: getContextWindowTokens?.(),
          });

          // A page of a capped read is not a repeat read: following the note into
          // the next part must not look like re-reading the same content (#811).
          const isRepeatRead = unchanged && (offset === undefined || offset === 1);
          onScorecardFileRead?.(absPath, mtimeMs, isRepeatRead);
          return capped;
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to read file" };
        }
      },
    }),

    // read_and_summarize returns a derived summary, not raw file bytes.
    read_and_summarize: defineTool({
      description:
        "Read a file and return a structured summary: key exports, imports/dependencies, and basic metrics. Use instead of read_file when you need an overview of a file.",
      parameters: z.object({
        path: z.string().describe("File path (relative to working dir or absolute)"),
      }),
      execute: async ({ path }) => {
        const absPath = resolvePath(path);
        try {
          if (!existsSync(absPath)) {
            return { ok: false, error: `File not found: ${path}` };
          }

          const content = readFileSync(absPath, "utf-8");
          const lines = content.split("\n");

          // Extract exports (declarations + named exports)
          const exports: string[] = [];
          const exportDeclPattern = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type)\s+(\w+)/g;
          let match;
          while ((match = exportDeclPattern.exec(content)) !== null) {
            exports.push(match[1]);
          }
          // Named exports: export { foo, bar } or export { foo } from './mod'
          const exportNamedPattern = /export\s*\{([^}]+)\}/g;
          while ((match = exportNamedPattern.exec(content)) !== null) {
            const names = match[1].split(",").map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
            exports.push(...names);
          }

          // Extract imports (import statements + require calls)
          const imports: string[] = [];
          const importFromPattern = /import\s+.*?\s+from\s+["']([^"']+)["']/g;
          while ((match = importFromPattern.exec(content)) !== null) {
            imports.push(match[1]);
          }
          // Side-effect imports: import "foo"
          const sideEffectPattern = /^import\s+["']([^"']+)["']/gm;
          while ((match = sideEffectPattern.exec(content)) !== null) {
            imports.push(match[1]);
          }
          // require("foo")
          const requirePattern = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
          while ((match = requirePattern.exec(content)) !== null) {
            imports.push(match[1]);
          }

          // Extract function declarations (named functions + arrow functions)
          const functions: string[] = [];
          const funcPattern = /(?:async\s+)?function\s+(\w+)/g;
          while ((match = funcPattern.exec(content)) !== null) {
            functions.push(match[1]);
          }
          // Arrow functions: const name = async () =>
          const arrowFuncPattern = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/g;
          while ((match = arrowFuncPattern.exec(content)) !== null) {
            functions.push(match[1]);
          }
          // Function expressions: const name = async function
          const funcExprPattern = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/g;
          while ((match = funcExprPattern.exec(content)) !== null) {
            functions.push(match[1]);
          }

          // Check for concerns (large files, many TODOs, many exports)
          const concerns: string[] = [];
          if (lines.length > 500) concerns.push(`Large file: ${lines.length} lines`);
          const todoCount = (content.match(/TODO|FIXME|HACK/gi) ?? []).length;
          if (todoCount > 3) concerns.push(`Many TODOs/FIXMEs: ${todoCount}`);
          if (exports.length > 15) concerns.push(`Many exports: ${exports.length}`);

          return {
            ok: true,
            path,
            lines: lines.length,
            exports,
            functions,
            imports,
            concerns,
            contentPreview: lines.slice(0, 20).join("\n"),
          };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to summarize file" };
        }
      },
    }),

    load_skill: defineTool({
      description:
        "Load a skill's full instructions from the skill catalog by name. " +
        "Use this when a skill in the catalog is relevant to the current task.",
      parameters: z.object({
        skill_id: z.string().describe("Skill name from the catalog"),
      }),
      execute: async ({ skill_id }) => {
        const skill = skills.find((s) => s.name === skill_id);
        if (!skill) {
          return { ok: false, error: `Unknown skill: ${skill_id}` };
        }
        try {
          if (!existsSync(skill.location)) {
            return { ok: false, error: `Skill file not found: ${skill.name}` };
          }
          const body = readFileSync(skill.location, "utf-8");
          const bodyTokens = estimateTokens(body);

          if (skillRuntime) {
            skillRuntime.trackLoad(skill_id, getCurrentTurn(), bodyTokens);
          } else {
            onScorecardSkillLoad?.(skill_id, bodyTokens);
          }

          return { ok: true, body };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? `Failed to load skill: ${skill.name}` };
        }
      },
    }),

    write_file: defineTool({
      description:
        "Create or overwrite a file. Creates parent directories if needed. " +
        "Do not issue this tool concurrently with other write_file/edit_file/batch_write/batch_edit calls targeting the same path.",
      parameters: z.object({
        path: z.string().describe("File path (relative to working dir or absolute)"),
        content: z.string().describe("Content to write"),
      }),
      execute: async ({ path, content }) => {
        const absPath = resolvePath(path);
        try {
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, content);
          invalidateReadPath(absPath);
          const warning = validateStructuredContent(absPath, content);
          return warning ? { ok: true, warning } : { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to write file" };
        }
      },
    }),

    edit_file: defineTool({
      description:
        "Replace a specific text block in a file. Finds the exact oldText and replaces with newText. Fails if oldText is not unique in the file. " +
        "Do not issue this tool concurrently with other write_file/edit_file/batch_write/batch_edit calls targeting the same path.",
      parameters: z.object({
        path: z.string().describe("File path (relative to working dir or absolute)"),
        oldText: z.string().describe("Exact text to find and replace"),
        newText: z.string().describe("Replacement text"),
      }),
      execute: async ({ path, oldText, newText }) => {
        const absPath = resolvePath(path);
        try {
          if (!existsSync(absPath)) {
            return { ok: false, error: `File not found: ${path}` };
          }

          const originalBytes = readFileSync(absPath);
          const content = originalBytes.toString("utf-8");

          // Exact match via indexOf — no regex, handles all special chars
          const idx = content.indexOf(oldText);
          if (idx === -1) {
            return {
              ok: false,
              error: "oldText not found in file. Make sure the text matches exactly.",
            };
          }
          if (content.indexOf(oldText, idx + 1) !== -1) {
            const count = content.split(oldText).length - 1;
            return {
              ok: false,
              error: `oldText found ${count} times in file. Must be unique. Provide more context to make it unique.`,
            };
          }
          const newContent = content.slice(0, idx) + newText + content.slice(idx + oldText.length);

          // Preview the diff and confirm before touching the file when
          // edit.confirm is on. The session owns the prompt (#748): a TUI
          // session shows this text in its overlay, a classic session prints
          // the coloured preview and asks on the terminal, a headless one
          // refuses. Without a callback there is nothing to ask through.
          if (editConfirm) {
            const matchLine = content.slice(0, idx).split("\n").length;
            const preview: PreviewLine[] = [
              { text: `--- ${path}:${matchLine} (before)`, tone: "dim" },
              ...oldText.split("\n").map(
                (line: string): PreviewLine => ({ text: `- ${line}`, tone: "remove" }),
              ),
              { text: `+++ ${path}:${matchLine} (after)`, tone: "dim" },
              ...newText.split("\n").map(
                (line: string): PreviewLine => ({ text: `+ ${line}`, tone: "add" }),
              ),
            ];
            const decision = confirmAction
              ? await confirmAction({ question: "Apply edit? [y/N]", preview })
              : null;
            if (!decision?.allowed) {
              return { ok: false, error: actionRefusalError("edit", decision) };
            }
            if (!readFileSync(absPath).equals(originalBytes)) {
              return { ok: false, error: "File changed while waiting for confirmation; nothing was written" };
            }
          }

          writeFileSync(absPath, newContent);
          invalidateReadPath(absPath);
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to edit file" };
        }
      },
    }),

    batch_write: defineTool({
      description:
        "Write multiple files atomically. All files are written or none. Creates parent directories as needed. Use for creating multi-file components in one call. " +
        "Do not issue this tool concurrently with other write_file/edit_file/batch_write/batch_edit calls targeting the same path.",
      parameters: z.object({
        files: z.array(z.object({
          path: z.string().describe("File path"),
          content: z.string().describe("File content"),
        })).describe("Array of files to write"),
      }),
      execute: async ({ files }) => {
        // Validate all paths first (all must resolve)
        const resolved: Array<{ absPath: string; content: string; relPath: string }> = [];
        for (const f of files) {
          const absPath = resolvePath(f.path);
          resolved.push({ absPath, content: f.content, relPath: f.path });
        }

        // Write all files, tracking what was written for rollback
        const written: string[] = [];
        const originals = new Map<string, string>();
        try {
          for (const { absPath, content, relPath } of resolved) {
            // Save original if file exists (for rollback)
            if (existsSync(absPath)) {
              originals.set(absPath, readFileSync(absPath, "utf-8"));
            }
            mkdirSync(dirname(absPath), { recursive: true });
            writeFileSync(absPath, content);
            written.push(relPath);
          }
          for (const { absPath } of resolved) {
            invalidateReadPath(absPath);
          }
          return { ok: true, files: written };
        } catch (err: any) {
          // Rollback: restore originals, delete newly created files
          for (const { absPath } of resolved) {
            if (originals.has(absPath)) {
              try { writeFileSync(absPath, originals.get(absPath)!); } catch { /* best-effort */ }
            } else if (written.some((r) => resolvePath(r) === absPath)) {
              try { rmSync(absPath); } catch { /* best-effort */ }
            }
          }
          return { ok: false, error: err?.message ?? "Batch write failed", written };
        }
      },
    }),

    batch_edit: defineTool({
      description:
        "Edit multiple files atomically. All edits are applied or none. Edits to the same file are applied sequentially (each edit sees the result of the previous one). Edits across different files are independent. Use for multi-file refactors in one call. " +
        "Do not issue this tool concurrently with other write_file/edit_file/batch_write/batch_edit calls targeting the same path.",
      parameters: z.object({
        edits: z.array(z.object({
          path: z.string().describe("File path"),
          oldText: z.string().describe("Exact text to find"),
          newText: z.string().describe("Replacement text"),
        })).describe("Array of edits to apply"),
      }),
      execute: async ({ edits }) => {
        if (edits.length === 0) {
          return { ok: true, files: [] };
        }

        // Resolve paths and verify files exist
        const resolvedEdits: Array<{ absPath: string; oldText: string; newText: string; relPath: string }> = [];
        for (const e of edits) {
          const absPath = resolvePath(e.path);
          if (!existsSync(absPath)) {
            return { ok: false, error: `File not found: ${e.path}` };
          }
          resolvedEdits.push({ absPath, oldText: e.oldText, newText: e.newText, relPath: e.path });
        }

        // Snapshot original contents for rollback
        const snapshots = new Map<string, string>();
        const workingContents = new Map<string, string>();
        for (const { absPath } of resolvedEdits) {
          if (!snapshots.has(absPath)) {
            const original = readFileSync(absPath, "utf-8");
            snapshots.set(absPath, original);
            workingContents.set(absPath, original);
          }
        }

        const edited: string[] = [];

        try {
          for (const { absPath, oldText, newText, relPath } of resolvedEdits) {
            const content = workingContents.get(absPath)!;
            const idx = content.indexOf(oldText);
            if (idx === -1) {
              throw new Error(`oldText not found in ${relPath}`);
            }
            if (content.indexOf(oldText, idx + 1) !== -1) {
              throw new Error(`oldText not unique in ${relPath}`);
            }
            workingContents.set(
              absPath,
              content.slice(0, idx) + newText + content.slice(idx + oldText.length),
            );
            edited.push(relPath);
          }

          for (const [absPath, content] of workingContents) {
            writeFileSync(absPath, content);
          }

          for (const absPath of workingContents.keys()) {
            invalidateReadPath(absPath);
          }

          return { ok: true, files: edited };
        } catch (err: any) {
          for (const [absPath, original] of snapshots) {
            try { writeFileSync(absPath, original); } catch { /* best-effort */ }
          }
          return { ok: false, error: err?.message ?? "Batch edit failed", edited };
        }
      },
    }),
  };
}
