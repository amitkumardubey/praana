import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { findGitRoot } from "../git-context.js";

export type MemoryScope = "global" | "project";

export function projectKey(cwd: string, findRoot: (cwd: string) => string = findGitRoot): string {
  const root = resolve(findRoot(resolve(cwd)));
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 6);
  return `${slug}-${hash}`;
}

export function memoryDirectories(home: string, key: string): Record<MemoryScope, string> {
  const base = join(resolve(home), ".praana");
  return { global: join(base, "memory"), project: join(base, "projects", key, "memory") };
}
