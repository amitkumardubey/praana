import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { createFileMemoryStore } from "../src/file-memory/store.js";
import { recordMemoryPaths } from "./helpers/file-memory-fs.js";
import { spawnMemoryChild } from "./helpers/file-memory-process.js";

const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true }); });
async function tempHome() { const home = await fs.mkdtemp(join(tmpdir(), "memory-isolation-")); homes.push(home); return home; }
const contained = (home: string, path: string) => { const rel = relative(home, path); return isAbsolute(path) && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`); };
const entry = { scope: "global" as const, type: "user" as const, name: "isolated", description: "Isolated filesystem fixture", body: "Complete searchable content" };

test("every filesystem-seam path across all store APIs stays under the injected home", async () => {
  const home = await tempHome();
  expect(home).not.toBe(process.env.HOME);
  const recording = recordMemoryPaths(home);
  const store = createFileMemoryStore({ home, cwd: join(home, "project"), findRoot: (cwd) => cwd, fs: recording.fs });
  for (const scope of ["global", "project"] as const) {
    expect((await store.write({ ...entry, scope })).ok).toBe(true);
    expect((await store.write({ ...entry, scope, body: "Updated searchable content" })).ok).toBe(true);
    expect((await store.read({ name: entry.name, scope })).ok).toBe(true);
    expect((await store.list({ scope })).ok).toBe(true);
    expect((await store.refreshIndexFile(scope)).ok).toBe(true);
  }
  expect((await store.read({ name: entry.name })).ok).toBe(true);
  expect((await store.recall({ name: entry.name })).ok).toBe(true);
  expect((await store.recall({ query: "searchable" })).ok).toBe(true);
  expect((await store.buildMemoryIndex()).total).toBe(2);
  expect((await store.list()).entries).toHaveLength(2);
  expect((await store.remove({ name: entry.name })).ok).toBe(false);
  for (const scope of ["global", "project"] as const) expect((await store.remove({ name: entry.name, scope })).ok).toBe(true);
  expect((await store.read({ name: entry.name })).ok).toBe(false);
  expect((await store.remove({ name: entry.name })).ok).toBe(false);
  const count = recording.paths.length;
  for (const name of ["../escape", "/outside", "x/y", ".hidden", "Upper", "memory", "con"]) {
    expect((await store.write({ ...entry, name })).ok).toBe(false);
    expect((await store.read({ name })).ok).toBe(false);
    expect((await store.remove({ name })).ok).toBe(false);
    expect((await store.recall({ name })).ok).toBe(false);
  }
  expect(recording.paths.length).toBe(count);
  expect(recording.paths.length).toBeGreaterThan(100);
  for (const record of recording.paths) expect(contained(home, record.path)).toBe(true);
  expect([...new Set(recording.paths.map((record) => record.operation))].sort()).toEqual(["lstat", "mkdir", "open", "readdir", "realpath", "rename", "stat", "unlink"]);
});

test("child scripts use injected HOME and record every store filesystem path inside it", async () => {
  const home = await tempHome();
  const child = await spawnMemoryChild(home, `
    const store = createFileMemoryStore(storeOptions);
    for (const result of [await store.write(${JSON.stringify(entry)}), await store.read({ name: "isolated" }), await store.recall({ query: "searchable" }), await store.list(), await store.remove({ name: "isolated" })]) {
      if (!result.ok) throw new Error(JSON.stringify(result));
    }
    console.log(JSON.stringify({ ok: true, home: process.env.HOME }));
  `);
  try {
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(JSON.parse(output)).toEqual({ ok: true, home });
    const scripts = await fs.readdir(join(home, "scripts"));
    const traces = scripts.filter((file) => file.endsWith(".paths.jsonl"));
    expect(traces).toHaveLength(1);
    const records = (await fs.readFile(join(home, "scripts", traces[0]!), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { path: string });
    expect(records.length).toBeGreaterThan(20);
    for (const record of records) expect(contained(home, record.path)).toBe(true);
    for (const script of scripts) expect(contained(home, await fs.realpath(join(home, "scripts", script)))).toBe(true);
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}, 15000);

function sourceImports(text: string, path: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const arg = node.arguments[0]; if (arg && ts.isStringLiteralLike(arg)) imports.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return imports;
}

test("static import scan recognizes imports, reexports, dynamic imports and require", () => {
  expect(sourceImports('import { x } from "./one.js"; export * from "./two.js"; import("./three.js"); require("./four.js"); // import("ignored")', "fixture.ts")).toEqual(["./one.js", "./two.js", "./three.js", "./four.js"]);
});

test("file memory is production-inert and imports no legacy memory or compiler modules", async () => {
  const src = resolve(import.meta.dir, "../src"), moduleRoot = join(src, "file-memory");
  let files = 0, localFiles = 0;
  for await (const path of new Bun.Glob("**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}").scan({ cwd: src, absolute: true })) {
    files++;
    const local = contained(moduleRoot, path);
    if (local) localFiles++;
    for (const specifier of sourceImports(await fs.readFile(path, "utf8"), path)) {
      const resolved = resolve(dirname(path), specifier);
      if (!local) expect(contained(moduleRoot, resolved) || /(?:^|\/)file-memory(?:\/|$)/.test(specifier)).toBe(false);
      else {
        expect(contained(join(src, "memory"), resolved)).toBe(false);
        expect(contained(join(src, "context-engine"), resolved)).toBe(false);
        expect(resolved.replace(/\.(?:[cm]?[jt]sx?)$/, "")).not.toBe(join(src, "compiler"));
      }
    }
  }
  expect(files).toBeGreaterThan(100);
  expect(localFiles).toBe(6);
});
