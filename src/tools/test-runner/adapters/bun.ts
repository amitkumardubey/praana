/**
 * Bun test runner adapter.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandOnPath } from "../../../verify/spawn.js";
import type { ParsedOutput, TestFailure, TestRunnerAdapter } from "../types.js";

const FAIL_LINE = /^\(fail\)\s+(.+?)(?:\s+\[[^\]]+\])?\s*$/;
const PASS_LINE = /^\(pass\)\s+(.+?)(?:\s+\[[^\]]+\])?\s*$/;
const SKIP_LINE = /^\(skip\)\s+(.+?)(?:\s+\[[^\]]+\])?\s*$/;
const FILE_HEADER = /^(\S.+):\s*$/;

export class BunAdapter implements TestRunnerAdapter {
  readonly name = "bun";

  detect(cwd: string): boolean {
    if (
      existsSync(join(cwd, "bun.lockb")) ||
      existsSync(join(cwd, "bun.lock"))
    ) {
      return true;
    }
    if (
      commandOnPath("bun") &&
      existsSync(join(cwd, "package.json")) &&
      !existsSync(join(cwd, "pnpm-lock.yaml")) &&
      !existsSync(join(cwd, "yarn.lock")) &&
      !existsSync(join(cwd, "package-lock.json"))
    ) {
      return true;
    }
    return false;
  }

  buildCommand(opts: {
    cwd: string;
    files?: string[];
    command?: string;
  }): { command: string; args: string[] } {
    if (opts.command) {
      const parts = opts.command.trim().split(/\s+/);
      const cmd = parts[0] ?? "bun";
      const rest = parts.slice(1);
      if (opts.files?.length) {
        return { command: cmd, args: [...rest, ...opts.files] };
      }
      return { command: cmd, args: rest };
    }
    const args = ["test"];
    if (opts.files?.length) {
      args.push(...opts.files);
    }
    return { command: "bun", args };
  }

  parseOutput(
    stdout: string,
    stderr: string,
    exitCode: number | null,
  ): ParsedOutput {
    const text = `${stdout}\n${stderr}`;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let currentFile = "";
    const failures: TestFailure[] = [];
    const files: string[] = [];

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const header = line.match(FILE_HEADER);
      if (header && /\.(test|spec)\./i.test(header[1] ?? "")) {
        currentFile = header[1] ?? "";
        if (currentFile && !files.includes(currentFile)) {
          files.push(currentFile);
        }
        continue;
      }
      if (PASS_LINE.test(line)) {
        passed += 1;
        continue;
      }
      if (SKIP_LINE.test(line)) {
        skipped += 1;
        continue;
      }
      const fail = line.match(FAIL_LINE);
      if (fail) {
        failed += 1;
        const msgLines: string[] = [];
        for (let j = i + 1; j < lines.length && j <= i + 12; j++) {
          const next = lines[j] ?? "";
          if (
            /^\((pass|fail|skip)\)/.test(next) ||
            FILE_HEADER.test(next) ||
            /^\s*\d+\s+(pass|fail)/.test(next)
          ) {
            break;
          }
          if (next.trim()) {
            msgLines.push(next.trim());
          }
        }
        failures.push({
          name: fail[1]?.trim() ?? "fail",
          file: currentFile || undefined,
          message: msgLines.join("\n"),
        });
      }
    }

    // Also check summary line if counts were not captured line-by-line
    const summaryPass = text.match(/(\d+)\s+pass\b/i);
    const summaryFail = text.match(/(\d+)\s+fail\b/i);
    const summarySkip = text.match(/(\d+)\s+skip\b/i);

    if (summaryPass && passed === 0) passed = parseInt(summaryPass[1]!, 10);
    if (summaryFail && failed === 0) failed = parseInt(summaryFail[1]!, 10);
    if (summarySkip && skipped === 0) skipped = parseInt(summarySkip[1]!, 10);

    if (failed === 0 && exitCode !== 0 && exitCode !== null) {
      failed = 1;
      failures.push({
        name: "bun test",
        message: stderr.trim() || stdout.trim() || `exited with code ${exitCode}`,
      });
    }

    const summary = `${passed} passed, ${failed} failed, ${skipped} skipped`;

    return { passed, failed, skipped, files, failures, summary };
  }
}
