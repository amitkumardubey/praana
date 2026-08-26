/**
 * Generic fallback test runner adapter.
 */

import type { ParsedOutput, TestFailure, TestRunnerAdapter } from "../types.js";

export class GenericAdapter implements TestRunnerAdapter {
  readonly name = "generic";

  detect(_cwd: string): boolean {
    return true;
  }

  buildCommand(opts: {
    cwd: string;
    files?: string[];
    command?: string;
  }): { command: string; args: string[] } {
    if (opts.command) {
      const parts = opts.command.trim().split(/\s+/);
      const cmd = parts[0] ?? "test";
      const rest = parts.slice(1);
      if (opts.files?.length) {
        return { command: cmd, args: [...rest, ...opts.files] };
      }
      return { command: cmd, args: rest };
    }
    return { command: "npm", args: ["test"] };
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
    const failures: TestFailure[] = [];
    const files: string[] = [];

    // Check generic pass/fail lines
    const passMatches = text.match(/\b(PASS|passing|ok)\b/gi);
    const failMatches = text.match(/\b(FAIL|failed|failing|error)\b/gi);

    const summaryPass = text.match(/(\d+)\s+(?:passed|passing)\b/i);
    const summaryFail = text.match(/(\d+)\s+(?:failed|failing)\b/i);
    const summarySkip = text.match(/(\d+)\s+(?:skipped|ignored)\b/i);

    if (summaryPass) passed = parseInt(summaryPass[1]!, 10);
    else if (passMatches && exitCode === 0) passed = passMatches.length;

    if (summaryFail) failed = parseInt(summaryFail[1]!, 10);
    else if (exitCode !== 0 && exitCode !== null) failed = 1;

    if (summarySkip) skipped = parseInt(summarySkip[1]!, 10);

    if (exitCode !== 0 && exitCode !== null) {
      if (failed === 0) failed = 1;
      const errorLines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /(fail|error|exception|panic)/i.test(l))
        .slice(0, 10);
      failures.push({
        name: "Test failure",
        message: errorLines.join("\n") || stderr.trim() || stdout.trim() || `exited with code ${exitCode}`,
      });
    }

    const summary = `${passed} passed, ${failed} failed, ${skipped} skipped`;
    return { passed, failed, skipped, files, failures, summary };
  }
}
