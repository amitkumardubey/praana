import type { ParseDiagnostic } from "../native/types.js";

export interface SyntaxResult {
  diagnostics: ParseDiagnostic[];
  skipped?: string;
}

export interface TypecheckError {
  file: string;
  line: number;
  col: number;
  message: string;
}

export interface TypecheckResult {
  errors: TypecheckError[];
  skipped?: string;
}

export interface TestFailure {
  name: string;
  file: string;
  message: string;
}

export interface TestsResult {
  passed?: number;
  failed?: number;
  files?: string[];
  failures?: TestFailure[];
  skipped?: string;
  graph_truncated?: boolean;
}

export interface VerifyPayload {
  cached?: true;
  syntax?: SyntaxResult;
  typecheck?: TypecheckResult;
  tests?: TestsResult;
}

export const VERIFY_DIAG_CAP = 20;
export const VERIFY_TSC_CAP = 20;
export const VERIFY_MAX_GRAPH_FILES = 2000;
