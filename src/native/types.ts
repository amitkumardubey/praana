/**
 * Native capability boundary types (issues #313, #11 Phase 1).
 * See docs/superpowers/specs/2026-08-11-rust-native-runtime-design.md
 * and docs/superpowers/specs/2026-08-12-tree-sitter-code-intel-design.md
 */

/** Major-compatible API version expected by this PRAANA tree. */
export const EXPECTED_NATIVE_API_MAJOR = 0;

export type NativeErrorCode =
   | "unavailable"
   | "disabled"
  | "version_mismatch"
  | "invalid_argument"
  | "io_error"
  | "parse_error"
  | "unsupported_language"
  | "cancelled"
  | "internal";

export class NativeUnavailableError extends Error {
  readonly code: NativeErrorCode;
  readonly causeMessage?: string;

  constructor(code: NativeErrorCode, message: string, causeMessage?: string) {
    super(message);
    this.name = "NativeUnavailableError";
    this.code = code;
    this.causeMessage = causeMessage;
  }
}

export interface ParseDiagnostic {
  message: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface SymbolHit {
  path: string;
  name: string;
  kind: string;
  exported: boolean;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface ImportHit {
  path: string;
  source: string;
  names: string[];
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface ProjectQueryOpts {
  language?: string;
  maxFiles?: number;
  maxHits?: number;
}

export interface ParseFileResult {
  ok: boolean;
  error?: string | null;
  code?: string | null;
  language?: string | null;
  diagnostics: ParseDiagnostic[];
}

export interface ListSymbolsResult {
  ok: boolean;
  error?: string | null;
  code?: string | null;
  language?: string | null;
  symbols: SymbolHit[];
}

export interface ListImportsResult {
  ok: boolean;
  error?: string | null;
  code?: string | null;
  language?: string | null;
  imports: ImportHit[];
}

export interface ProjectHitsResult {
  ok: boolean;
  error?: string | null;
  code?: string | null;
  hits: SymbolHit[];
  truncated: boolean;
  filesScanned: number;
}

export interface NativeGrepOpts {
  pattern: string;
  path: string;
  globs?: string[] | null;
  globExclude?: string[] | null;
  caseInsensitive?: boolean | null;
  context?: number | null;
  maxResults?: number | null;
  maxFileSize?: number | null;
  timeBudgetMs?: number | null;
}

export interface NativeGrepMatch {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface NativeGrepResult {
  ok: boolean;
  error?: string | null;
  code?: string | null;
  matches: NativeGrepMatch[];
  truncated: boolean;
  filesSearched: number;
  regexFallback?: string | null;
}

export interface NativeFindFilesOpts {
  pattern: string;
  path: string;
  mode?: string | null;
  maxResults?: number | null;
}

export interface NativeFindFilesMatch {
  path: string;
  relativePath: string;
  name: string;
  size: number;
  modified: number;
}

export interface NativeFindFilesResult {
  ok: boolean;
  error?: string | null;
  code?: string | null;
  matches: NativeFindFilesMatch[];
  truncated: boolean;
  totalMatched: number;
}

export interface NativeEmbedResult {
  ok: boolean;
  error?: string | null;
  code?: string | null;
  dim: number;
  embedding: number[];
}

/** Bindings for native API 0.3+ (tree-sitter, search, embed). */
export interface NativeBindings {
  nativeVersion(): string;
  ping(): string;
  parseFile(path: string, language?: string | null): ParseFileResult;
  listSymbols(path: string, language?: string | null): ListSymbolsResult;
  listImports(path: string, language?: string | null): ListImportsResult;
  findDefinition(
    root: string,
    symbol: string,
    opts?: ProjectQueryOpts | null,
  ): ProjectHitsResult;
  findReferences(
    root: string,
    symbol: string,
    opts?: ProjectQueryOpts | null,
  ): ProjectHitsResult;
  grep(opts: NativeGrepOpts): NativeGrepResult;
  findFiles(opts: NativeFindFilesOpts): NativeFindFilesResult;
  embedText(text: string, modelDir: string): NativeEmbedResult;
}

export interface NativeLoadResult {
  available: boolean;
  bindings: NativeBindings | null;
  error: NativeUnavailableError | null;
}
