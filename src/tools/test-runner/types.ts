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

/** Completed run with structured counts (`failed > 0` means tests ran and failed). */
export interface RunTestsSuccess {
  ok: true;
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

/** Same shape as success but `ok: false` — tests ran and reported failures. */
export interface RunTestsFailed extends Omit<RunTestsSuccess, "ok"> {
  ok: false;
}

export interface RunTestsError {
  ok: false;
  error: string;
  runner?: string;
  command?: string;
  code?: string;
}

export type RunTestsResult = RunTestsSuccess | RunTestsFailed | RunTestsError;

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
