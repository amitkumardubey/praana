import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const ROOTS = ["compaction.ts", "compaction-requests.ts"];

/** Relative-import closure of the compaction modules, from Bun's parser (not a regex). */
function importClosure(): Map<string, string[]> {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const graph = new Map<string, string[]>();
  const pending = ROOTS.map((file) => resolve(SRC, file));
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || graph.has(file)) continue;
    const deps = transpiler
      .scanImports(readFileSync(file, "utf8"))
      .map((entry) => entry.path)
      .filter((path) => path.startsWith("."))
      .map((path) => resolve(dirname(file), path).replace(/\.js$/, ".ts"));
    graph.set(file, deps);
    pending.push(...deps);
  }
  return graph;
}

test("compaction modules never reach src/memory/ or checkpoint.ts, even transitively, and do not self-import", () => {
  const graph = importClosure();
  const reached = [...graph.keys()].map((file) => relative(SRC, file));
  expect(reached).toContain("compaction.ts");
  expect(reached).toContain("frozen-summary.ts");
  expect(reached.filter((file) => file.startsWith("memory/") || /(^|\/)checkpoint\.ts$/.test(file))).toEqual([]);
  for (const root of ROOTS) {
    const file = resolve(SRC, root);
    expect(graph.get(file) ?? []).not.toContain(file);
  }
});
