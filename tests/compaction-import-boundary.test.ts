import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const ROOTS = ["compaction.ts", "compaction-requests.ts", "compaction-types.ts"];

function relativeImports(source: string): string[] {
  return ts.preProcessFile(source, true, true).importedFiles.map(entry => entry.fileName).filter(path => path.startsWith("."));
}

function forbidden(file: string): boolean {
  return /(^|\/)(?:file-)?memory\//.test(file) || /(^|\/)checkpoint\.ts$/.test(file);
}

/** Relative-import closure of the compaction modules, using a parser (not a regex). */
function importClosure(): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const pending = ROOTS.map((file) => resolve(SRC, file));
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || graph.has(file)) continue;
    const deps = relativeImports(readFileSync(file, "utf8"))
      .map((path) => resolve(dirname(file), path).replace(/\.js$/, ".ts"));
    graph.set(file, deps);
    pending.push(...deps);
  }
  return graph;
}

test("import scanning includes type-only memory, checkpoint, re-export and self edges", () => {
  expect(relativeImports([
    'import type {} from "./memory/store.js";',
    'export type { X } from "./file-memory/store.js";',
    'import type {} from "./checkpoint.js";',
    'import type {} from "./compaction.js";',
  ].join("\n"))).toEqual(["./memory/store.js", "./file-memory/store.js", "./checkpoint.js", "./compaction.js"]);
  for (const file of ["memory/store.ts", "file-memory/store.ts", "nested/file-memory/store.ts", "checkpoint.ts"]) expect(forbidden(file)).toBe(true);
  expect(forbidden("frozen-summary.ts")).toBe(false);
});

test("compaction modules do not import each other cyclically", () => {
  const graph = importClosure();
  const modules = new Set(ROOTS.map(file => resolve(SRC, file)));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (file: string) => {
    expect(visiting.has(file)).toBe(false);
    if (visited.has(file)) return;
    visiting.add(file);
    for (const dependency of graph.get(file) ?? []) if (modules.has(dependency)) visit(dependency);
    visiting.delete(file);
    visited.add(file);
  };
  for (const root of ROOTS) visit(resolve(SRC, root));
});

test("compaction modules never reach memory, file-memory or checkpoint.ts, even transitively, and do not self-import", () => {
  const graph = importClosure();
  const reached = [...graph.keys()].map((file) => relative(SRC, file));
  expect(reached).toContain("compaction.ts");
  expect(reached).toContain("frozen-summary.ts");
  expect(reached.filter((file) => forbidden(file))).toEqual([]);
  for (const root of ROOTS) {
    const file = resolve(SRC, root);
    expect(graph.get(file) ?? []).not.toContain(file);
  }
});
