/**
 * LSP workspace-root resolution (issue #11 Phase 4).
 *
 * Extra roots partition the session tree (JS workspace members + nested git).
 * Paths outside the session root stay the session root — the manager still
 * rejects them via inWorkspace.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { findGitRoot, isGitRepo } from "../git-context.js";

export function normalizeRoot(p: string): string {
  return p.replace(/\/+$/, "") || p;
}

export function pathInRoot(absPath: string, root: string): boolean {
  const r = normalizeRoot(root);
  const p = absPath;
  return p === r || p.startsWith(r + "/");
}

function longestPrefix(path: string, candidates: string[]): string | null {
  let best: string | null = null;
  for (const c of candidates) {
    const n = normalizeRoot(c);
    if (!pathInRoot(path, n)) continue;
    if (!best || n.length > best.length) best = n;
  }
  return best;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function workspacePatternsFromPackageJson(anchor: string): string[] {
  const pkg = readJson(join(anchor, "package.json"));
  if (!pkg || typeof pkg !== "object") return [];
  const ws = (pkg as { workspaces?: unknown }).workspaces;
  if (Array.isArray(ws)) {
    return ws.filter((x): x is string => typeof x === "string");
  }
  if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    return (ws as { packages: unknown[] }).packages.filter(
      (x): x is string => typeof x === "string",
    );
  }
  return [];
}

function workspacePatternsFromPnpm(anchor: string): string[] {
  const path = join(anchor, "pnpm-workspace.yaml");
  if (!existsSync(path)) return [];
  try {
    const parsed = Bun.YAML.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return [];
    const packages = (parsed as { packages?: unknown }).packages;
    if (!Array.isArray(packages)) return [];
    return packages.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function hasPackageJson(dir: string): boolean {
  return existsSync(join(dir, "package.json"));
}

/** Convert a workspace glob to a posix-relative pattern. */
function globToRegExp(pattern: string): { recursive: boolean; re: RegExp } {
  const posixPat = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  const recursive = posixPat.includes("**");
  const escaped = posixPat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\0")
    .replace(/\*/g, "[^/]+")
    .replace(/\0/g, ".*");
  return { recursive, re: new RegExp(`^${escaped}$`) };
}

function walkDirs(anchor: string, recursive: boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue;
      const full = join(dir, name);
      if (!isDir(full)) continue;
      out.push(full);
      if (recursive) walk(full);
    }
  };
  walk(anchor);
  return out;
}

function expandPattern(anchor: string, pattern: string): string[] {
  const posixPat = pattern.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!posixPat.includes("*")) {
    const full = join(anchor, ...posixPat.split("/"));
    return isDir(full) && hasPackageJson(full) ? [normalizeRoot(full)] : [];
  }
  const { recursive, re } = globToRegExp(posixPat);
  const all = recursive
    ? walkDirs(anchor, true)
    : collectOneGlobLevel(anchor, posixPat);
  const matches: string[] = [];
  for (const d of all) {
    const rel = relative(anchor, d).split(sep).join("/");
    if (re.test(rel) && hasPackageJson(d)) matches.push(normalizeRoot(d));
  }
  return matches;
}

function collectOneGlobLevel(anchor: string, posixPat: string): string[] {
  // `packages/*` → list packages/*; `*` → list anchor/*
  const parts = posixPat.split("/");
  const starAt = parts.indexOf("*");
  if (starAt === -1) {
    return walkDirs(anchor, false);
  }
  const prefix = parts.slice(0, starAt).join("/");
  const base = prefix ? join(anchor, ...prefix.split("/")) : anchor;
  if (!isDir(base)) return [];
  return readdirSync(base)
    .map((n) => join(base, n))
    .filter(isDir);
}

export function discoverWorkspaceMembers(anchor: string): string[] {
  const patterns = [
    ...workspacePatternsFromPackageJson(anchor),
    ...workspacePatternsFromPnpm(anchor),
  ];
  const include: string[] = [];
  const exclude: string[] = [];
  for (const p of patterns) {
    const negated = p.startsWith("!");
    const raw = negated ? p.slice(1) : p;
    const expanded = expandPattern(anchor, raw);
    if (negated) exclude.push(...expanded);
    else include.push(...expanded);
  }
  const excluded = new Set(exclude.map(normalizeRoot));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of include) {
    const n = normalizeRoot(m);
    if (excluded.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function nestedGitRoot(absPath: string, sessionRoot: string): string | null {
  const start = existsSync(absPath) && isDir(absPath) ? absPath : dirname(absPath);
  if (!isGitRepo(start)) return null;
  const root = normalizeRoot(findGitRoot(start));
  const session = normalizeRoot(sessionRoot);
  if (!pathInRoot(root, session)) return null;
  if (root === session) return null;
  return root;
}

/**
 * Most-specific LSP spawn root for `absPath` inside `sessionRoot`.
 */
export function resolveLspRoot(absPath: string, sessionRoot: string): string {
  const session = normalizeRoot(sessionRoot);
  if (!pathInRoot(absPath, session)) return session;

  const gitCandidate = nestedGitRoot(absPath, session);
  const anchor = gitCandidate ?? (isGitRepo(session) ? findGitRoot(session) : session);
  const members = discoverWorkspaceMembers(normalizeRoot(anchor));
  const member = longestPrefix(absPath, members);
  if (member) return member;
  if (gitCandidate) return gitCandidate;
  return session;
}
