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
import * as toml from "toml";
import type { SandboxConfig } from "../types.js";
import type { SkillRecord } from "../skills/types.js";
import type { SkillRuntime } from "../skills/index.js";
import type { ScorecardInc } from "../context-engine/telemetry.js";
import { estimateTokens } from "../token-estimate.js";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { writeUiStderr } from "../ui.js";
import { detectShellReads } from "./shell-read-detect.js";
import { buildPathChurnHint } from "./read-churn.js";

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
    try { toml.parse(content); } catch (e: any) {
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
  shellLiveStream?: boolean;
  skills: SkillRecord[];
  skillRuntime: SkillRuntime | null;
  skillScorecard?: ScorecardInc;
  onScorecardFileRead?: (absPath: string, mtimeMs?: number, countAsRepeat?: boolean) => void;
  onScorecardSkillLoad?: (skillId: string, bodyTokens: number) => void;
  getCurrentTurn: () => number;
  /** When true, second+ read_file of same abs path hard-fails. */
  blockRepeatReads?: boolean;
  hasReadPath?: (absPath: string) => boolean;
  /** mtime from last successful read; used to detect external edits. */
  getReadPathMtime?: (absPath: string) => number | undefined;
  clearReadPath?: (absPath: string) => void;
  /** Legacy path-only lookup (deprecated, prefer findFileReadArtifactByRange). */
  findFileReadArtifact?: (
    absPath: string,
  ) => {
    id: string;
    createdTurn: number;
    card: string;
  } | null;
  /** Find an artifact for a specific read_file line range. */
  findFileReadArtifactByRange?: (
    absPath: string,
    offset?: number,
    limit?: number,
  ) => {
    id: string;
    createdTurn: number;
    card: string;
  } | null;
}

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
          return resolved === apResolved || resolved.startsWith(apResolved + "/");
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

export function createSystemTools(ctx: SystemToolContext) {
  const {
    cwd,
    getAbortSignal,
    sandbox,
    editConfirm,
    shellLiveStream,
    skills,
    skillRuntime,
    skillScorecard,
    onScorecardFileRead,
    onScorecardSkillLoad,
    getCurrentTurn,
    blockRepeatReads = false,
    hasReadPath,
    getReadPathMtime,
    clearReadPath,
    findFileReadArtifact,
    findFileReadArtifactByRange,
  } = ctx;

  const resolvePath = (p: string): string => {
    if (isAbsolute(p)) return p;
    return resolve(cwd, p);
  };

  const invalidateReadPath = (absPath: string): void => {
    clearReadPath?.(absPath);
  };

  // Guard against concurrent mutating-tool calls targeting the same path.
  // The model is responsible for avoiding conflicting parallel writes; this
  // is a lightweight runtime safety net that catches same-batch collisions.
  const pendingWritePaths = new Set<string>();

  function acquireWritePath(
    absPath: string,
    relPath: string,
  ): { ok: true } | { ok: false; error: string } {
    if (pendingWritePaths.has(absPath)) {
      return {
        ok: false,
        error: `Concurrent write already in progress for ${relPath}. Avoid parallel mutating tool calls targeting the same path.`,
      };
    }
    pendingWritePaths.add(absPath);
    return { ok: true };
  }

  function releaseWritePath(absPath: string): void {
    pendingWritePaths.delete(absPath);
  }

  return {
    shell: defineTool({
      description:
        "Execute a shell command in the working directory. Returns stdout, stderr, and exit code.",
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
        // when the same path has been accessed repeatedly (issue #294).
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
        "If this path was already read this session and is unchanged, prefer retrieve_artifact " +
        "or search_turn_events instead of calling read_file again.",
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
        // Guard: if a write to this path is in progress (e.g. an edit_file
        // blocked on confirmation in a concurrent batch), fail fast instead
        // of reading stale or partial content.
        if (pendingWritePaths.has(absPath)) {
          return {
            ok: false,
            error: `A write to ${path} is currently in progress. Avoid concurrent read_file and write_file/edit_file/batch_write/batch_edit calls targeting the same path.`,
          };
        }
        try {
          let hasReadBefore = hasReadPath?.(absPath) ?? false;

          // External edits (outside write_file/edit_file) bump mtime — allow a fresh read.
          if (hasReadBefore && existsSync(absPath)) {
            const diskMtime = statSync(absPath).mtimeMs;
            const priorMtime = getReadPathMtime?.(absPath);
            if (priorMtime !== undefined && diskMtime !== priorMtime) {
              clearReadPath?.(absPath);
              hasReadBefore = false;
            }
          }

          // Range-aware lookup: find artifact for exact requested line range.
          // Different ranges should read from disk; exact matches are cached.
          let cachedResult: { card: string; id: string; createdTurn: number } | null = null;
          let shouldBlock = false;
          let shouldWarn = false;
          if (hasReadBefore) {
            // Try exact range lookup if range-aware function is available
            if (findFileReadArtifactByRange) {
              cachedResult = findFileReadArtifactByRange(absPath, offset, limit);
              if (cachedResult) {
                // Check mtime to validate artifact freshness for range matches.
                if (existsSync(absPath)) {
                  const diskMtime = statSync(absPath).mtimeMs;
                  const currentMtime = getReadPathMtime?.(absPath);
                  if (currentMtime !== undefined && diskMtime !== currentMtime) {
                    cachedResult = null;
                  }
                }
                if (cachedResult) {
                  shouldBlock = true;
                }
              }
            } else if (findFileReadArtifact) {
              // Classic mode (no range support): use path-level lookup for warn/block
              cachedResult = findFileReadArtifact(absPath);
              if (cachedResult && existsSync(absPath)) {
                const diskMtime = statSync(absPath).mtimeMs;
                const currentMtime = getReadPathMtime?.(absPath);
                if (currentMtime !== undefined && diskMtime !== currentMtime) {
                  cachedResult = null;
                }
              }
              if (cachedResult) {
                shouldBlock = true;
              } else {
                // Path was read before but no artifact - warn in warn mode
                shouldWarn = true;
              }
            } else {
              // True classic mode: no cache functions, warn/block on any path read
              cachedResult = null; // No artifact, but path was read
              shouldWarn = true;
            }
          }
          if (shouldBlock && cachedResult) {
            // Exact range or path match found → treat as repeat.
            onScorecardFileRead?.(absPath);
            const hint = `Already read turn ${cachedResult.createdTurn} — use retrieve_artifact("${cachedResult.id}") or search_turn_events`;

            if (blockRepeatReads) {
              return { ok: false, error: hint };
            }

            return {
              ok: true,
              content: cachedResult.card,
              warning: hint,
              artifact_id: cachedResult.id,
              original_turn: cachedResult.createdTurn,
              skipped_disk: true,
            };
          }

          // Warn in classic mode if path was read but no cached result
          if (shouldWarn) {
            onScorecardFileRead?.(absPath);
            const hint = `Already read this session — use retrieve_artifact or search_turn_events instead of re-reading ${path}`;
            if (blockRepeatReads) {
              return { ok: false, error: hint };
            }
            return {
              ok: true,
              content: hint,
              warning: hint,
              skipped_disk: true,
            };
          }

          // Fresh read from disk.
          if (!existsSync(absPath)) {
            return { ok: false, error: `File not found: ${path}` };
          }

          const mtimeMs = statSync(absPath).mtimeMs;
          const content = readFileSync(absPath, "utf-8");
          let lines = content.split("\n");

          if (offset !== undefined) {
            lines = lines.slice(offset - 1);
          }
          if (limit !== undefined) {
            lines = lines.slice(0, limit);
          }

          onScorecardFileRead?.(absPath, mtimeMs, false);
          return { ok: true, content: lines.join("\n") };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to read file" };
        }
      },
    }),

    // deliberate: read_and_summarize is not covered by the repeat-read interceptor —
    // it returns a derived summary, not raw file bytes, and is out of scope for #219.
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
        const guard = acquireWritePath(absPath, path);
        if (!guard.ok) return guard;
        try {
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, content);
          invalidateReadPath(absPath);
          const warning = validateStructuredContent(absPath, content);
          return warning ? { ok: true, warning } : { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to write file" };
        } finally {
          releaseWritePath(absPath);
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
        const guard = acquireWritePath(absPath, path);
        if (!guard.ok) return guard;
        try {
          if (!existsSync(absPath)) {
            return { ok: false, error: `File not found: ${path}` };
          }

          const content = readFileSync(absPath, "utf-8");

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

          // Show diff and prompt for confirmation if editConfirm is enabled
          if (editConfirm) {
            const matchLine = content.slice(0, idx).split("\n").length;
            const oldLines = oldText.split("\n");
            const newLines = newText.split("\n");
            writeUiStderr(chalk.dim(`\n--- ${path}:${matchLine} (before)`));
            for (const line of oldLines) writeUiStderr(chalk.red(`- ${line}`));
            writeUiStderr(chalk.dim(`+++ ${path}:${matchLine} (after)`));
            for (const line of newLines) writeUiStderr(chalk.green(`+ ${line}`));
            const answer = await new Promise<string>((resolve) => {
              const rl = createInterface({
                input: process.stdin,
                output: process.stderr,
              });
              rl.question("Apply edit? [y/N] ", (ans) => {
                rl.close();
                resolve(ans.trim().toLowerCase());
              });
            });
            if (answer !== "y" && answer !== "yes") {
              return { ok: false, error: "Edit cancelled by user" };
            }
          }

          writeFileSync(absPath, newContent);
          invalidateReadPath(absPath);
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to edit file" };
        } finally {
          releaseWritePath(absPath);
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

        // Acquire locks for all files before writing. Duplicate paths within
        // one batch are allowed (last content wins); the lock is acquired once.
        const acquired = new Set<string>();
        for (const { absPath, relPath } of resolved) {
          if (acquired.has(absPath)) continue;
          const guard = acquireWritePath(absPath, relPath);
          if (!guard.ok) {
            for (const a of acquired) releaseWritePath(a);
            return guard;
          }
          acquired.add(absPath);
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
        } finally {
          for (const a of acquired) releaseWritePath(a);
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

        // Acquire locks for all files before editing. Duplicates within one batch are allowed.
        const acquired = new Set<string>();
        for (const { absPath, relPath } of resolvedEdits) {
          if (acquired.has(absPath)) continue;
          const guard = acquireWritePath(absPath, relPath);
          if (!guard.ok) {
            for (const a of acquired) releaseWritePath(a);
            return guard;
          }
          acquired.add(absPath);
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
        } finally {
          for (const a of acquired) releaseWritePath(a);
        }
      },
    }),
  };
}
