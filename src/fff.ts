import { join, relative, isAbsolute, normalize } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { SandboxConfig } from "./types.js";

/**
 * fff lifecycle manager — wraps @ff-labs/fff-bun's FileFinder.
 *
 * The FileFinder is created at session start; the initial scan runs in the
 * background. The first search_code / find_files call awaits scan completion
 * (with timeout) if needed. Resources are freed at session end via destroy().
 *
 * A single shared cache (scoped by cwd) ensures only one FileFinder instance
 * and one background scan per project directory.
 */

export interface FffManager {
  ensureReady(timeoutMs?: number): Promise<{ ok: true; value: boolean } | { ok: false; error: string }>;
  isAvailable(): boolean;
  getBasePath(): string;
  destroy(): void;
  isDestroyed(): boolean;
  raw(): unknown;
}

let _fffLoadError: string | null = null;
let _cachedAvailable: boolean | null = null;

async function tryImportFff(): Promise<typeof import("@ff-labs/fff-bun") | null> {
  try {
    const mod = (await import("@ff-labs/fff-bun")) as typeof import("@ff-labs/fff-bun");
    return mod;
  } catch (e) {
    _fffLoadError = (e as Error).message;
    return null;
  }
}

export function getFffLoadError(): string | null {
  return _fffLoadError;
}

/** Async probe — actually tries to import. Caches the result. */
export async function isFffAvailable(): Promise<boolean> {
  if (_cachedAvailable !== null) return _cachedAvailable;
  const mod = await tryImportFff();
  if (!mod) {
    _cachedAvailable = false;
    return false;
  }
  try {
    _cachedAvailable = mod.FileFinder.isAvailable();
  } catch {
    _cachedAvailable = false;
  }
  return _cachedAvailable ?? false;
}

export async function createFffManager(basePath: string): Promise<FffManager> {
  const mod = await tryImportFff();
  if (!mod) {
    const err = _fffLoadError ?? "fff native library not available";
    return createFailedManager(basePath, err);
  }
  if (!mod.FileFinder.isAvailable()) {
    return createFailedManager(basePath, "fff native library not available for this platform");
  }
  const result = mod.FileFinder.create({ basePath, aiMode: true });
  if (!result.ok) {
    return createFailedManager(basePath, result.error);
  }
  _cachedAvailable = true;
  const finder = result.value;
  let destroyed = false;

  return {
    async ensureReady(timeoutMs = 5000) {
      if (destroyed) return { ok: false, error: "FileFinder has been destroyed" };
      try {
        const r = await finder.waitForScan(timeoutMs);
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, value: r.value };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    isAvailable() {
      return !destroyed && finder.isDestroyed === false;
    },
    getBasePath() {
      return basePath;
    },
    destroy() {
      if (!destroyed) {
        destroyed = true;
        try {
          finder.destroy();
        } catch {
          // ignore
        }
      }
    },
    isDestroyed() {
      return destroyed || finder.isDestroyed;
    },
    raw() {
      return finder;
    },
  };
}

function createFailedManager(basePath: string, error: string): FffManager {
  return {
    async ensureReady() {
      return { ok: false, error };
    },
    isAvailable() {
      return false;
    },
    getBasePath() {
      return basePath;
    },
    destroy() {},
    isDestroyed() {
      return true;
    },
    raw() {
      return null;
    },
  };
}

/** Reset cached availability state — tests only. */
export function resetFffCache(): void {
  _fffLoadError = null;
  _cachedAvailable = null;
}

// ---- Shared FileFinder cache (single instance per cwd) ----

const fffCache = new Map<string, Promise<FffManager>>();

export async function getFffManager(cwd: string): Promise<FffManager> {
  const cached = fffCache.get(cwd);
  if (cached) return cached;
  const promise = createFffManager(cwd);
  fffCache.set(cwd, promise);
  return promise;
}

export function clearFffCache(): void {
  for (const [, p] of fffCache) {
    void p.then((m) => {
      try {
        m.destroy();
      } catch {
        /* ignore */
      }
    });
  }
  fffCache.clear();
  resetFffCache();
}

// ---- Shared sandbox path validation ----

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
 * Map a `path` arg to an fff constraint token.
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
  // fff treats a token as a directory constraint when it ends with '/'.
  // A bare directory path (no trailing slash) would be treated as a fuzzy
  // pattern, so normalize to a directory constraint.
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

export function buildFffQuery(pattern: string, constraints: string[]): string {
  const filtered = constraints.filter(Boolean);
  if (filtered.length === 0) return pattern;
  return `${filtered.join(" ")} ${pattern}`;
}
