import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, relative } from "node:path";
import type { SandboxConfig } from "./types.js";

export function sandboxBlockReason(
  path: string,
  sandbox: SandboxConfig | undefined,
): string | null {
  if (!sandbox?.enabled || sandbox.allowed_paths.length === 0) return null;

  const resolve = (p: string): string => {
    const expanded = p.replace(/^~/, homedir());
    const normalized = normalize(expanded);
    if (!existsSync(normalized)) return normalized;
    try {
      return realpathSync(normalized);
    } catch {
      return normalized;
    }
  };

  const resolved = resolve(path);
  const allowed = sandbox.allowed_paths.some((ap) => {
    const apResolved = resolve(ap);
    return resolved === apResolved || resolved.startsWith(apResolved + "/");
  });

  return allowed
    ? null
    : `Blocked by sandbox: path not in allowed list: ${path}`;
}

/**
 * Map a `path` arg to a directory-relative token (trailing slash for dirs).
 */
export function pathToConstraint(basePath: string, userPath: string): string | null {
  if (!userPath || userPath === basePath) return null;
  let rel: string;
  if (isAbsolute(userPath)) {
    rel = relative(basePath, userPath);
    if (rel.startsWith("..")) return null;
  } else {
    rel = userPath;
    if (rel.startsWith("..")) return null;
  }
  rel = rel.replace(/^\.\//, "").replace(/\\/g, "/");
  if (!rel) return null;
  if (!rel.endsWith("/") && !rel.includes(".")) {
    rel = `${rel}/`;
  }
  return rel;
}

const FILE_TYPE_MAP: Record<string, string> = {
  ts: "*.ts",
  typescript: "*.ts",
  js: "*.js",
  javascript: "*.js",
  py: "*.py",
  python: "*.py",
  rust: "*.rs",
  rs: "*.rs",
  go: "*.go",
  java: "*.java",
  rb: "*.rb",
  ruby: "*.rb",
  c: "*.c",
  cpp: "*.cpp",
  h: "*.h",
  sh: "*.sh",
  lua: "*.lua",
  md: "*.md",
  json: "*.json",
  yaml: "*.yaml",
  yml: "*.yml",
  toml: "*.toml",
  css: "*.css",
  html: "*.html",
};

export function fileTypeToConstraint(fileType: string): string {
  const key = fileType.toLowerCase().trim();
  return FILE_TYPE_MAP[key] ?? `*.${key}`;
}

export function fileTypeToGlob(fileType: string): string {
  return fileTypeToConstraint(fileType);
}

export function toStringList(value?: string | string[]): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
