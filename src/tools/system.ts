import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve, isAbsolute, extname } from "node:path";
import * as toml from "toml";
import { createInterface } from "node:readline";
import chalk from "chalk";

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
  editConfirm?: boolean;
}

export function createSystemTools(ctx: SystemToolContext) {
  const { cwd, getAbortSignal, editConfirm } = ctx;

  const resolvePath = (p: string): string => {
    if (isAbsolute(p)) return p;
    return resolve(cwd, p);
  };

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

        const ms = timeout ?? 30000;
        return new Promise((resolve) => {
          const child = spawn(command, [], {
            cwd,
            shell: "/bin/bash",
            stdio: ["ignore", "pipe", "pipe"],
          });

          let stdout = "";
          let stderr = "";
          let settled = false;
          const maxBuf = 10 * 1024 * 1024; // 10MB

          const finish = (result: {
            ok: boolean;
            stdout: string;
            stderr: string;
            exitCode: number;
          }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(result);
          };

          const onAbort = () => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 3000);
          };

          signal?.addEventListener("abort", onAbort, { once: true });

          const timer = setTimeout(() => {
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), 3000);
          }, ms);

          child.stdout?.on("data", (chunk: Buffer) => {
            // Stream raw output to terminal so long-running commands show progress.
            // ANSI escape sequences from child processes pass through unmodified —
            // this matches standard terminal multiplexer behavior (script(1), tee).
            process.stdout.write(chunk);
            if (stdout.length < maxBuf) stdout += chunk.toString();
          });
          child.stderr?.on("data", (chunk: Buffer) => {
            process.stderr.write(chunk);
            if (stderr.length < maxBuf) stderr += chunk.toString();
          });

          child.on("close", (code) => {
            if (signal?.aborted) {
              finish({
                ok: false,
                stdout: stdout.slice(0, maxBuf),
                stderr: stderr.slice(0, maxBuf) || "Interrupted",
                exitCode: 130,
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
      },
    }),

    read_file: defineTool({
      description:
        "Read contents of a file. Supports optional offset and limit for partial reads.",
      parameters: z.object({
        path: z.string().describe("File path (relative to working dir or absolute)"),
        offset: z
          .number()
          .optional()
          .describe("Line number to start reading from (1-indexed)"),
        limit: z
          .number()
          .optional()
          .describe("Maximum lines to read"),
      }),
      execute: async ({ path, offset, limit }) => {
        const absPath = resolvePath(path);
        try {
          if (!existsSync(absPath)) {
            return { ok: false, error: `File not found: ${path}` };
          }

          const content = readFileSync(absPath, "utf-8");
          let lines = content.split("\n");

          if (offset !== undefined) {
            lines = lines.slice(offset - 1);
          }
          if (limit !== undefined) {
            lines = lines.slice(0, limit);
          }

          return { ok: true, content: lines.join("\n") };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to read file" };
        }
      },
    }),

    write_file: defineTool({
      description:
        "Create or overwrite a file. Creates parent directories if needed.",
      parameters: z.object({
        path: z.string().describe("File path (relative to working dir or absolute)"),
        content: z.string().describe("Content to write"),
      }),
      execute: async ({ path, content }) => {
        const absPath = resolvePath(path);
        try {
          mkdirSync(dirname(absPath), { recursive: true });
          writeFileSync(absPath, content);
          const warning = validateStructuredContent(absPath, content);
          return warning ? { ok: true, warning } : { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to write file" };
        }
      },
    }),

    edit_file: defineTool({
      description:
        "Replace a specific text block in a file. Finds the exact oldText and replaces with newText. Fails if oldText is not unique in the file.",
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
            console.error(chalk.dim(`\n--- ${path}:${matchLine} (before)`));
            for (const line of oldLines) console.error(chalk.red(`- ${line}`));
            console.error(chalk.dim(`+++ ${path}:${matchLine} (after)`));
            for (const line of newLines) console.error(chalk.green(`+ ${line}`));
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
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to edit file" };
        }
      },
    }),
  };
}
