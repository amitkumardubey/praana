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
  const key = resolveServerKey(language, servers);
  if (!key) return null;
  const argv = servers[key];
  return argv && argv.length > 0 ? argv : null;
}

/**
 * Config key for the process that serves `language`.
 * `javascript` shares the `typescript` server when it has no own entry.
 */
export function resolveServerKey(
  language: string,
  servers: Record<string, string[]>,
): string | null {
  const direct = servers[language];
  if (direct && direct.length > 0) return language;
  if (language === "javascript") {
    const ts = servers.typescript;
    if (ts && ts.length > 0) return "typescript";
  }
  return null;
}

/** Language id passed to textDocument/didOpen. */
export function lspLanguageId(language: string): string {
  if (language === "typescript") return "typescript";
  if (language === "javascript") return "javascript";
  return language;
}
