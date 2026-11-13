import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { findGitRoot } from "../git-context.js";

export type MemoryScope = "global" | "project";

export function projectKey(cwd: string, findRoot: (cwd: string) => string = findGitRoot): string {
  let root = resolve(findRoot(resolve(cwd)));
  try { root = realpathSync(root); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Only roots that do not exist as spelled retain their absolute identity.
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new Error(`cannot resolve project root: ${code ?? "unknown error"} ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 6);
  return `${slug}-${hash}`;
}

export function globalMemoryDirectory(home: string): string {
  return join(resolve(home), ".praana", "memory");
}

export function memoryDirectories(home: string, key: string): Record<MemoryScope, string> {
  const base = join(resolve(home), ".praana");
  return { global: globalMemoryDirectory(home), project: join(base, "projects", key, "memory") };
}
