/**
 * Tree-sitter syntax check for post-edit verification (#299).
 */

import type { ParseDiagnostic, ParseFileResult } from "../native/types.js";
import { VERIFY_DIAG_CAP, type SyntaxResult } from "./types.js";

export type ParseFileFn = (
  path: string,
  language?: string | null,
) => ParseFileResult;

export async function checkSyntax(
  absPath: string,
  opts: { parseFile?: ParseFileFn | null },
): Promise<SyntaxResult> {
  const parseFile = opts.parseFile;
  if (!parseFile) {
    return { diagnostics: [], skipped: "native_unavailable" };
  }
  try {
    const result = parseFile(absPath, null);
    if (!result.ok) {
      return { diagnostics: [], skipped: "parse_error" };
    }
    const diagnostics = (result.diagnostics ?? []).slice(0, VERIFY_DIAG_CAP);
    return { diagnostics };
  } catch {
    return { diagnostics: [], skipped: "parse_error" };
  }
}

export function syntaxHasErrors(result: SyntaxResult): boolean {
  return result.diagnostics.length > 0;
}

export type { ParseDiagnostic };
