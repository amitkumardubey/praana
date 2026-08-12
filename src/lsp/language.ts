/**
 * Language id resolution for LSP (issue #11 Phase 2).
 */

import { extname } from "node:path";

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
};

/** Map path extension to LSP language id, or null if unsupported in Phase 2. */
export function languageFromPath(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

/**
 * Resolve server argv for a language.
 * `javascript` falls back to `typescript` when no javascript entry exists.
 */
export function resolveServerArgv(
  language: string,
  servers: Record<string, string[]>,
): string[] | null {
  const direct = servers[language];
  if (direct && direct.length > 0) return direct;
  if (language === "javascript") {
    const ts = servers.typescript;
    if (ts && ts.length > 0) return ts;
  }
  return null;
}

/** Language id passed to textDocument/didOpen. */
export function lspLanguageId(language: string): string {
  if (language === "typescript") return "typescript";
  if (language === "javascript") return "javascript";
  return language;
}
