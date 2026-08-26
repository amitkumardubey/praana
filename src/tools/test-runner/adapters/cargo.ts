/**
 * Cargo (Rust) test runner adapter.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ParsedOutput, TestFailure, TestRunnerAdapter } from "../types.js";

const CARGO_TEST_LINE = /^test\s+(\S+)\s+\.\.\.\s+(ok|FAILED|ignored)$/;
const CARGO_SUMMARY = /test result:\s+(FAILED|ok)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored;/;

export class CargoAdapter implements TestRunnerAdapter {
  readonly name = "cargo";

  detect(cwd: string): boolean {
    return existsSync(join(cwd, "Cargo.toml"));
  }

  buildCommand(opts: {
    cwd: string;
    files?: string[];
    command?: string;
  }): { command: string; args: string[] } {
    if (opts.command) {
      const parts = opts.command.trim().split(/\s+/);
      const cmd = parts[0] ?? "cargo";
      const rest = parts.slice(1);
      if (opts.files?.length) {
        return { command: cmd, args: [...rest, "--", ...opts.files] };
      }
      return { command: cmd, args: rest };
    }
    const args = ["test"];
    if (opts.files?.length) {
      args.push("--", ...opts.files);
    }
    return { command: "cargo", args };
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
      const match = line.match(CARGO_TEST_LINE);
      if (match) {
        const [, name, status] = match;
        if (status === "ok") passed += 1;
        else if (status === "ignored") skipped += 1;
        else if (status === "FAILED") {
          failed += 1;
          failures.push({
            name: name ?? "Rust test",
            message: "Test failed (see cargo output)",
          });
        }
      }
    }

    const summaryMatch = text.match(CARGO_SUMMARY);
    if (summaryMatch) {
      passed = parseInt(summaryMatch[2]!, 10);
      failed = parseInt(summaryMatch[3]!, 10);
      skipped = parseInt(summaryMatch[4]!, 10);
    }

    // Try to extract failure details from "---- test_name stdout ----"
    const failureBlocks = text.split(/---- (.*?) stdout ----/);
    if (failureBlocks.length > 1) {
      for (let i = 1; i < failureBlocks.length; i += 2) {
        const name = failureBlocks[i]?.trim();
        const block = failureBlocks[i + 1]?.split("failures:")[0]?.trim();
        if (name && block) {
          const existing = failures.find((f) => f.name === name);
          if (existing) {
            existing.message = block;
          } else {
            failures.push({ name, message: block });
          }
        }
      }
    }

    if (failed === 0 && exitCode !== 0 && exitCode !== null) {
      failed = 1;
      failures.push({
        name: "cargo test",
        message: stderr.trim() || stdout.trim() || `exited with code ${exitCode}`,
      });
    }

    const summary = `${passed} passed, ${failed} failed, ${skipped} skipped`;
    return { passed, failed, skipped, files, failures, summary };
  }
}
