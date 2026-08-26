/**
 * Types and interfaces for the structured test runner (issue #321).
 */

import type { SandboxConfig } from "../../types.js";

export interface TestFailure {
  name: string;
  file?: string;
  message: string;
}

export interface ParsedOutput {
  passed: number;
  failed: number;
  skipped: number;
  files: string[];
  failures: TestFailure[];
  summary?: string;
}

export interface RunTestsSuccess {
  ok: boolean;
  runner: string;
  command: string;
  passed: number;
  failed: number;
  skipped: number;
  duration_ms: number;
  files: string[];
  failures: TestFailure[];
  summary: string;
  stdout?: string;
  stderr?: string;
}

export interface RunTestsError {
  ok: false;
  error: string;
  runner?: string;
  command?: string;
  code?: string;
}

export type RunTestsResult = RunTestsSuccess | RunTestsError;

export interface TestRunnerAdapter {
  readonly name: string;
  detect(cwd: string): boolean;
  buildCommand(opts: {
    cwd: string;
    files?: string[];
    command?: string;
  }): { command: string; args: string[] };
  parseOutput(
    stdout: string,
    stderr: string,
    exitCode: number | null,
  ): ParsedOutput;
}

export interface RunTestsContext {
  cwd: string;
  sandbox?: SandboxConfig;
  getAbortSignal?: () => AbortSignal | undefined;
}
