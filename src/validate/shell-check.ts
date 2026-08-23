/**
 * Shell cwd + first-token PATH check for pre-validation (#300).
 */

import { existsSync } from "node:fs";

export const SHELL_BUILTINS = new Set([
  "cd",
  "echo",
  "printf",
  "true",
  "false",
  "[",
  "test",
  "pwd",
  "export",
  "unset",
  "alias",
  "command",
  "type",
  "set",
  "shift",
  "source",
  ".",
  "eval",
  "exec",
  "exit",
  "return",
  "read",
  "umask",
  "ulimit",
  "times",
  "trap",
  "wait",
  "hash",
  "help",
  "history",
  "fc",
  "bg",
  "fg",
  "jobs",
  "kill",
  "bind",
  "builtin",
  "caller",
  "compgen",
  "complete",
  "compopt",
  "declare",
  "typeset",
  "dirs",
  "enable",
  "getopts",
  "let",
  "local",
  "logout",
  "mapfile",
  "readarray",
  "popd",
  "pushd",
  "shopt",
  "suspend",
]);

export function firstToken(command: string): string | null {
  const token = command.trim().split(/\s+/)[0];
  return token || null;
}

export interface CheckShellOpts {
  cwd?: string;
  pathExists?: (absPath: string) => boolean;
  commandOnPath?: (name: string) => boolean;
}

export function checkShellCommand(
  command: string,
  opts: CheckShellOpts = {},
): string | null {
  const exists = opts.pathExists ?? existsSync;
  if (typeof opts.cwd === "string" && opts.cwd.length > 0 && !exists(opts.cwd)) {
    return `shell cwd does not exist: ${opts.cwd}`;
  }
  const token = firstToken(command);
  if (!token) return "shell command is empty";
  if (SHELL_BUILTINS.has(token)) return null;
  const onPath = opts.commandOnPath;
  if (onPath ? onPath(token) : true) return null;
  return `command not found on PATH: ${token}`;
}
