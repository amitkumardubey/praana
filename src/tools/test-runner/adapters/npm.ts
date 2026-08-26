/**
 * Node/JS test runner adapter (npm, pnpm, yarn, vitest, jest).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ParsedOutput, TestFailure, TestRunnerAdapter } from "../types.js";

const JEST_FAIL_TEST = /●\s+(.+)$/;
const VITEST_FAIL_TEST = /❯\s+(.+)$/;
const JEST_FAIL_LINE = /^\s*FAIL\s+(\S.+)$/;
const JEST_PASS_LINE = /^\s*PASS\s+(\S.+)$/;

export class NpmAdapter implements TestRunnerAdapter {
  readonly name = "npm";

  private detectPackageManager(cwd: string): "pnpm" | "yarn" | "npm" {
    if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
    return "npm";
  }

  detect(cwd: string): boolean {
    // Any Node project (package.json) qualifies — the `test` script may be
    // named differently or the runner may accept files directly.
    return existsSync(join(cwd, "package.json"));
  }

  buildCommand(opts: {
    cwd: string;
    files?: string[];
    command?: string;
  }): { command: string; args: string[] } {
    if (opts.command) {
      const parts = opts.command.trim().split(/\s+/);
      const cmd = parts[0] ?? "npm";
      const rest = parts.slice(1);
      if (opts.files?.length) {
        return { command: cmd, args: [...rest, ...opts.files] };
      }
      return { command: cmd, args: rest };
    }

    const pm = this.detectPackageManager(opts.cwd);
    if (opts.files?.length) {
      if (pm === "yarn") {
        return { command: "yarn", args: ["test", ...opts.files] };
      }
      return { command: pm, args: ["test", "--", ...opts.files] };
    }
    return { command: pm, args: ["test"] };
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

    // Parse files from PASS/FAIL lines
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const passMatch = line.match(JEST_PASS_LINE);
      if (passMatch && passMatch[1]) {
        const f = passMatch[1].trim();
        if (!files.includes(f)) files.push(f);
      }
      const failMatch = line.match(JEST_FAIL_LINE);
      if (failMatch && failMatch[1]) {
        const f = failMatch[1].trim();
        if (!files.includes(f)) files.push(f);
      }
      const failHeader = line.match(JEST_FAIL_TEST) ?? line.match(VITEST_FAIL_TEST);
      if (failHeader) {
        const name = failHeader[1]?.trim() ?? "Test failure";
        const msgLines: string[] = [];
        for (let j = i + 1; j < lines.length && j <= i + 12; j++) {
          const next = lines[j] ?? "";
          if (
            JEST_FAIL_TEST.test(next) ||
            VITEST_FAIL_TEST.test(next) ||
            /^Test Suites:/.test(next) ||
            /^Tests:/.test(next)
          ) {
            break;
          }
          if (next.trim()) msgLines.push(next.trim());
        }
        failures.push({
          name,
          message: msgLines.join("\n"),
        });
      }
    }

    // Extract summary lines like "Tests: 2 failed, 15 passed, 17 total"
    const testsSummary = text.match(
      /Tests:\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+skipped,?\s*)?/i,
    );
    if (testsSummary) {
      failed = testsSummary[1] ? parseInt(testsSummary[1], 10) : 0;
      passed = testsSummary[2] ? parseInt(testsSummary[2], 10) : 0;
      skipped = testsSummary[3] ? parseInt(testsSummary[3], 10) : 0;
    } else {
      // Vitest summary fallback: "Tests  1 failed | 5 passed (6)"
      const vitestSummary = text.match(
        /Tests\s+(?:(\d+)\s+failed\s*\|?\s*)?(?:(\d+)\s+passed\s*\|?\s*)?(?:(\d+)\s+skipped\s*\|?\s*)?/i,
      );
      if (vitestSummary) {
        failed = vitestSummary[1] ? parseInt(vitestSummary[1], 10) : 0;
        passed = vitestSummary[2] ? parseInt(vitestSummary[2], 10) : 0;
        skipped = vitestSummary[3] ? parseInt(vitestSummary[3], 10) : 0;
      }
    }

    // If no counts were parsed but exit code is non-zero
    if (failed === 0 && exitCode !== 0 && exitCode !== null) {
      failed = Math.max(1, failures.length);
      if (failures.length === 0) {
        failures.push({
          name: "Test execution failed",
          message: stderr.trim() || stdout.trim() || `exited with code ${exitCode}`,
        });
      }
    }

    const summary = `${passed} passed, ${failed} failed, ${skipped} skipped`;
    return { passed, failed, skipped, files, failures, summary };
  }
}
