import { tool } from "ai";
import { z } from "zod";
import {
  execSync,
} from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";

export interface SystemToolContext {
  cwd: string;
}

export function createSystemTools(ctx: SystemToolContext) {
  const { cwd } = ctx;

  const resolvePath = (p: string): string => {
    if (isAbsolute(p)) return p;
    return resolve(cwd, p);
  };

  return {
    shell: tool({
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
        try {
          const result = execSync(command, {
            cwd,
            timeout: timeout ?? 30000,
            encoding: "utf-8",
            maxBuffer: 10 * 1024 * 1024, // 10MB
            shell: "/bin/bash",
          });

          return {
            ok: true,
            stdout: result,
            stderr: "",
            exitCode: 0,
          };
        } catch (err: any) {
          const stdout = err.stdout?.toString() ?? "";
          const stderr = err.stderr?.toString() ?? "";
          const exitCode = err.status ?? 1;

          return {
            ok: exitCode === 0,
            stdout,
            stderr,
            exitCode,
          };
        }
      },
    }),

    read_file: tool({
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

    write_file: tool({
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
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to write file" };
        }
      },
    }),

    edit_file: tool({
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

          // Count occurrences of oldText
          const escapedText = oldText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const regex = new RegExp(escapedText, "g");
          const matches = content.match(regex);

          if (!matches || matches.length === 0) {
            return {
              ok: false,
              error: "oldText not found in file. Make sure the text matches exactly.",
            };
          }

          if (matches.length > 1) {
            return {
              ok: false,
              error: `oldText found ${matches.length} times in file. Must be unique. Provide more context to make it unique.`,
            };
          }

          const newContent = content.replace(oldText, newText);
          writeFileSync(absPath, newContent);
          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Failed to edit file" };
        }
      },
    }),
  };
}
