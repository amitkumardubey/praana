/**
 * Pytest / Python test runner adapter.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ParsedOutput, TestFailure, TestRunnerAdapter } from "../types.js";

const PYTEST_SUMMARY = /=+\s+(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+skipped,?\s*)?in\s+([\d\.]+)s?\s+=+/i;
const PYTEST_FAIL_HEADER = /^_{3,}\s+(.+?)\s+_{3,}$/;
const PYTEST_SHORT_FAIL = /^FAILED\s+(.+?)(?:\s+-\s+(.+))?$/;

export class PytestAdapter implements TestRunnerAdapter {
  readonly name = "pytest";

  detect(cwd: string): boolean {
    return (
      existsSync(join(cwd, "pytest.ini")) ||
      existsSync(join(cwd, "pyproject.toml")) ||
      existsSync(join(cwd, "tox.ini")) ||
      existsSync(join(cwd, "setup.py")) ||
      existsSync(join(cwd, "conftest.py"))
    );
  }

  buildCommand(opts: {
    cwd: string;
    files?: string[];
    command?: string;
  }): { command: string; args: string[] } {
    if (opts.command) {
      const parts = opts.command.trim().split(/\s+/);
      const cmd = parts[0] ?? "pytest";
      const rest = parts.slice(1);
      if (opts.files?.length) {
        return { command: cmd, args: [...rest, ...opts.files] };
      }
      return { command: cmd, args: rest };
    }
    const args = ["-v"];
    if (opts.files?.length) {
      args.push(...opts.files);
    }
    return { command: "pytest", args };
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

    const summaryMatch = text.match(PYTEST_SUMMARY);
    if (summaryMatch) {
      failed = summaryMatch[1] ? parseInt(summaryMatch[1], 10) : 0;
      passed = summaryMatch[2] ? parseInt(summaryMatch[2], 10) : 0;
      skipped = summaryMatch[3] ? parseInt(summaryMatch[3], 10) : 0;
    }

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const shortFail = line.match(PYTEST_SHORT_FAIL);
      if (shortFail) {
        const fullTarget = shortFail[1]?.trim() ?? "";
        const parts = fullTarget.split("::");
        const file = parts[0] ?? "";
        const name = parts.slice(1).join("::") || file;
        const msg = shortFail[2]?.trim() || "Assertion / Test failure";
        if (file && !files.includes(file)) files.push(file);
        if (!failures.some((f) => f.name === name)) {
          failures.push({ name, file, message: msg });
        }
      }

      const failHeader = line.match(PYTEST_FAIL_HEADER);
      if (failHeader) {
        const name = failHeader[1]?.trim() ?? "pytest failure";
        const msgLines: string[] = [];
        for (let j = i + 1; j < lines.length && j <= i + 15; j++) {
          const next = lines[j] ?? "";
          if (
            PYTEST_FAIL_HEADER.test(next) ||
            /^=+\s+short test summary/.test(next) ||
            PYTEST_SUMMARY.test(next)
          ) {
            break;
          }
          if (next.trim()) msgLines.push(next.trim());
        }
        const existing = failures.find((f) => f.name === name);
        if (existing) {
          existing.message = msgLines.join("\n");
        } else {
          failures.push({ name, message: msgLines.join("\n") });
        }
      }
    }

    if (failed === 0 && exitCode !== 0 && exitCode !== null) {
      failed = Math.max(1, failures.length);
      if (failures.length === 0) {
        failures.push({
          name: "pytest",
          message: stderr.trim() || stdout.trim() || `exited with code ${exitCode}`,
        });
      }
    }

    const summary = `${passed} passed, ${failed} failed, ${skipped} skipped`;
    return { passed, failed, skipped, files, failures, summary };
  }
}
