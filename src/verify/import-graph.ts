/**
 * Reverse import graph for post-edit test-impact (#299).
 */

import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { pathInRoot } from "../lsp/workspace-roots.js";
import type { ListImportsResult } from "../native/types.js";
import { hashFileBytes } from "./cache.js";
import { VERIFY_MAX_GRAPH_FILES } from "./types.js";

export const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

export type ListImportsFn = (
  path: string,
  language?: string | null,
) => ListImportsResult;

export interface ReverseImportGraph {
  /** Absolute path → files that import it. */
  importers: Map<string, string[]>;
  files: string[];
  truncated: boolean;
}

export function walkSourceFiles(
  root: string,
  cap = VERIFY_MAX_GRAPH_FILES,
): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const rootAbs = resolve(root);
  const stack = [rootAbs];
  const visited = new Set<string>();
  let truncated = false;

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    if (!pathInRoot(real, rootAbs) && real !== rootAbs) continue;
    visited.add(real);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let lst;
      try {
        lst = lstatSync(full);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) continue;
        if (!st.isFile()) continue;
        if (!SOURCE_EXTS.has(extname(name).toLowerCase())) continue;
        files.push(full);
        if (files.length >= cap) return { files, truncated: true };
        continue;
      }
      if (lst.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!lst.isFile()) continue;
      if (!SOURCE_EXTS.has(extname(name).toLowerCase())) continue;
      files.push(full);
      if (files.length >= cap) {
        truncated = true;
        return { files, truncated };
      }
    }
  }
  return { files, truncated };
}

export function resolveImportSpecifier(
  fromFile: string,
  specifier: string,
  existingFiles: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = resolve(dirname(fromFile), specifier);
  for (const candidate of expandCandidates(resolved)) {
    if (existingFiles.has(candidate)) return candidate;
  }
  return null;
}

function expandCandidates(resolved: string): string[] {
  const out: string[] = [resolved];
  const ext = extname(resolved).toLowerCase();
  if (ext) {
    const stem = resolved.slice(0, -ext.length);
    for (const mapped of JS_TO_TS[ext] ?? []) {
      out.push(stem + mapped);
    }
    return out;
  }
  for (const e of SOURCE_EXTS) {
    out.push(resolved + e);
    out.push(join(resolved, `index${e}`));
  }
  return out;
}

export function buildReverseImportGraph(
  root: string,
  opts: {
    listImports?: ListImportsFn | null;
    maxFiles?: number;
    files?: string[];
    truncated?: boolean;
  } = {},
): ReverseImportGraph {
  const walked =
    opts.files !== undefined
      ? { files: opts.files, truncated: opts.truncated ?? false }
      : walkSourceFiles(root, opts.maxFiles ?? VERIFY_MAX_GRAPH_FILES);
  const files = walked.files;
  const existing = new Set(files);
  const importers = new Map<string, string[]>();
  const listImports = opts.listImports;

  if (listImports) {
    for (const file of files) {
      let listed: ListImportsResult;
      try {
        listed = listImports(file, null);
      } catch {
        continue;
      }
      if (!listed.ok) continue;
      for (const hit of listed.imports ?? []) {
        const target = resolveImportSpecifier(file, hit.source, existing);
        if (!target) continue;
        const list = importers.get(target) ?? [];
        if (!list.includes(file)) list.push(file);
        importers.set(target, list);
      }
    }
  }

  return { importers, files, truncated: walked.truncated };
}

export class ImportGraphCache {
  private cached: {
    root: string;
    fileKey: string;
    hashes: Map<string, string>;
    graph: ReverseImportGraph;
  } | null = null;

  get(
    root: string,
    opts: {
      listImports?: ListImportsFn | null;
      maxFiles?: number;
    } = {},
  ): ReverseImportGraph {
    const walked = walkSourceFiles(root, opts.maxFiles ?? VERIFY_MAX_GRAPH_FILES);
    const fileKey = [...walked.files].sort().join("\0");
    const hashes = new Map<string, string>();
    for (const file of walked.files) {
      const hash = hashFileBytes(file);
      if (hash) hashes.set(file, hash);
    }

    if (
      this.cached &&
      this.cached.root === root &&
      this.cached.fileKey === fileKey &&
      hashesMatch(this.cached.hashes, hashes)
    ) {
      return this.cached.graph;
    }

    const graph = buildReverseImportGraph(root, {
      listImports: opts.listImports,
      maxFiles: opts.maxFiles,
      files: walked.files,
      truncated: walked.truncated,
    });
    this.cached = { root, fileKey, hashes, graph };
    return graph;
  }

  clear(): void {
    this.cached = null;
  }
}

function hashesMatch(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}
