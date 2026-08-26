/**
 * Go test runner adapter.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ParsedOutput, TestFailure, TestRunnerAdapter } from "../types.js";

const GO_PASS = /--- PASS:\s+(\S+)\s+\(([^)]+)\)/;
const GO_FAIL = /--- FAIL:\s+(\S+)\s+\(([^)]+)\)/;
const GO_SKIP = /--- SKIP:\s+(\S+)\s+\(([^)]+)\)/;

export class GoAdapter implements TestRunnerAdapter {
  readonly name = "go";

  detect(cwd: string): boolean {
    return existsSync(join(cwd, "go.mod"));
  }

  buildCommand(opts: {
    cwd: string;
    files?: string[];
    command?: string;
  }): { command: string; args: string[] } {
    if (opts.command) {
      const parts = opts.command.trim().split(/\s+/);
      const cmd = parts[0] ?? "go";
      const rest = parts.slice(1);
      if (opts.files?.length) {
        return { command: cmd, args: [...rest, ...opts.files] };
      }
      return { command: cmd, args: rest };
    }
    const args = ["test", "-v"];
    if (opts.files?.length) {
      args.push(...opts.files);
    } else {
      args.push("./...");
    }
    return { command: "go", args };
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

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";

      const passMatch = line.match(GO_PASS);
      if (passMatch) {
        passed += 1;
        continue;
      }

      const skipMatch = line.match(GO_SKIP);
      if (skipMatch) {
        skipped += 1;
        continue;
      }

      const failMatch = line.match(GO_FAIL);
      if (failMatch) {
        failed += 1;
        const name = failMatch[1] ?? "Test failure";
        const msgLines: string[] = [];
        for (let j = Math.max(0, i - 10); j < i; j++) {
          const prev = lines[j]?.trim() ?? "";
          if (prev && !prev.startsWith("=== RUN") && !prev.startsWith("---")) {
            msgLines.push(prev);
          }
        }
        failures.push({
          name,
          message: msgLines.join("\n") || `Failed in ${failMatch[2] ?? "test"}`,
        });
      }
    }

    if (failed === 0 && exitCode !== 0 && exitCode !== null) {
      failed = 1;
      failures.push({
        name: "go test",
        message: stderr.trim() || stdout.trim() || `exited with code ${exitCode}`,
      });
    }

    const summary = `${passed} passed, ${failed} failed, ${skipped} skipped`;
    return { passed, failed, skipped, files, failures, summary };
  }
}
