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
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".json": "json",
  ".jsonc": "json",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
};

export interface DefaultLspServerSpec {
  binary: string;
  args: string[];
  npmPackages?: string[];
  toolchainInstall?: {
    command: string;
    args: string[];
  };
}

export const DEFAULT_LSP_SERVERS: Record<string, DefaultLspServerSpec> = {
  typescript: {
    binary: "typescript-language-server",
    args: ["--stdio"],
    npmPackages: ["typescript-language-server", "typescript"],
  },
  // Note: no "javascript" entry — resolveServerKey() routes javascript to the
  // typescript server unless the user configures an explicit javascript override.
  python: {
    binary: "pyright-langserver",
    args: ["--stdio"],
    npmPackages: ["pyright"],
  },
  go: {
    binary: "gopls",
    args: [],
    toolchainInstall: {
      command: "go",
      args: ["install", "golang.org/x/tools/gopls@latest"],
    },
  },
  rust: {
    binary: "rust-analyzer",
    args: [],
    toolchainInstall: {
      command: "rustup",
      args: ["component", "add", "rust-analyzer"],
    },
  },
  json: {
    binary: "vscode-json-language-server",
    args: ["--stdio"],
    npmPackages: ["vscode-langservers-extracted"],
  },
  html: {
    binary: "vscode-html-language-server",
    args: ["--stdio"],
    npmPackages: ["vscode-langservers-extracted"],
  },
  css: {
    binary: "vscode-css-language-server",
    args: ["--stdio"],
    npmPackages: ["vscode-langservers-extracted"],
  },
  yaml: {
    binary: "yaml-language-server",
    args: ["--stdio"],
    npmPackages: ["yaml-language-server"],
  },
  toml: {
    binary: "taplo",
    args: ["lsp", "stdio"],
    npmPackages: ["@taplo/cli"],
  },
};

/** Map path extension to LSP language id. */
export function languageFromPath(path: string): string | null {
  const ext = extname(path).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

/**
 * Resolve server argv for a language.
 * Checks user config first, then falls back to default registry.
 */
export function resolveServerArgv(
  language: string,
  servers: Record<string, string[]>,
): string[] | null {
  const key = resolveServerKey(language, servers);
  if (!key) return null;
  const configured = servers[key];
  if (configured && configured.length > 0) return configured;

  const defaultSpec = DEFAULT_LSP_SERVERS[key];
  if (defaultSpec) {
    return [defaultSpec.binary, ...defaultSpec.args];
  }
  return null;
}

/**
 * Config key for the process that serves `language`.
 * `javascript` shares the `typescript` server unless it has an explicit entry.
 */
export function resolveServerKey(
  language: string,
  servers: Record<string, string[]>,
): string | null {
  const direct = servers[language];
  if (direct && direct.length > 0) return language;
  if (language === "javascript") {
    // No explicit javascript override — share the typescript server.
    return "typescript";
  }
  if (DEFAULT_LSP_SERVERS[language]) {
    return language;
  }
  return null;
}

/** Language id passed to textDocument/didOpen. */
export function lspLanguageId(language: string): string {
  if (language === "typescript") return "typescript";
  if (language === "javascript") return "javascript";
  if (language === "python") return "python";
  if (language === "go") return "go";
  if (language === "rust") return "rust";
  if (language === "json") return "json";
  if (language === "html") return "html";
  if (language === "css") return "css";
  if (language === "yaml") return "yaml";
  if (language === "toml") return "toml";
  return language;
}
