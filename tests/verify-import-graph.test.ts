import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ImportGraphCache,
  buildReverseImportGraph,
  resolveImportSpecifier,
  walkSourceFiles,
} from "../src/verify/import-graph.js";
import type { ListImportsResult } from "../src/native/types.js";

function emptyImports(): ListImportsResult {
  return { ok: true, language: "typescript", imports: [] };
}

function importsOf(...sources: string[]): ListImportsResult {
  return {
    ok: true,
    language: "typescript",
    imports: sources.map((source) => ({
      path: "",
      source,
      names: [],
      startLine: 1,
      startCol: 1,
      endLine: 1,
      endCol: 1,
    })),
  };
}

describe("resolveImportSpecifier", () => {
  let dir: string;
  let files: Set<string>;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-ig-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    files = new Set();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a relative .js specifier to a .ts file", () => {
    const from = join(dir, "a.ts");
    const target = join(dir, "b.ts");
    files.add(from);
    files.add(target);
    expect(resolveImportSpecifier(from, "./b.js", files)).toBe(target);
  });

  it("skips bare packages and node: specifiers", () => {
    const from = join(dir, "a.ts");
    files.add(from);
    files.add(join(dir, "fs.ts"));
    expect(resolveImportSpecifier(from, "lodash", files)).toBeNull();
    expect(resolveImportSpecifier(from, "node:fs", files)).toBeNull();
  });
});

describe("walkSourceFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-walk-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips node_modules, dist, and .git", () => {
    writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "export {};\n");
    writeFileSync(join(dir, "dist", "a.js"), "export {};\n");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "x.ts"), "export {};\n");
    const { files, truncated } = walkSourceFiles(dir, 2000);
    expect(truncated).toBe(false);
    expect(files).toEqual([join(dir, "src", "a.ts")]);
  });

  it("sets truncated when the walk cap is hit", () => {
    writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
    writeFileSync(join(dir, "src", "b.ts"), "export {};\n");
    const { files, truncated } = walkSourceFiles(dir, 1);
    expect(truncated).toBe(true);
    expect(files).toHaveLength(1);
  });

  it("does not follow directory symlink cycles", () => {
    writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
    symlinkSync(dir, join(dir, "src", "loop"));
    const started = Date.now();
    const { files, truncated } = walkSourceFiles(dir, 2000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(truncated).toBe(false);
    expect(files).toEqual([join(dir, "src", "a.ts")]);
  });
});

describe("buildReverseImportGraph", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-rev-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("inverts relative imports", () => {
    const a = join(dir, "a.ts");
    const b = join(dir, "b.ts");
    writeFileSync(a, "export {};\n");
    writeFileSync(b, 'import "./a.js";\n');
    const graph = buildReverseImportGraph(dir, {
      listImports: (path) => (path === b ? importsOf("./a.js") : emptyImports()),
    });
    expect(graph.importers.get(a)).toEqual([b]);
  });
});

describe("ImportGraphCache", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-igc-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds when a scanned file hash changes", () => {
    const a = join(dir, "a.ts");
    writeFileSync(a, "export const n = 1;\n");
    let calls = 0;
    const listImports = () => {
      calls += 1;
      return emptyImports();
    };
    const cache = new ImportGraphCache();
    cache.get(dir, { listImports });
    const afterFirst = calls;
    cache.get(dir, { listImports });
    expect(calls).toBe(afterFirst);
    writeFileSync(a, "export const n = 2;\n");
    cache.get(dir, { listImports });
    expect(calls).toBeGreaterThan(afterFirst);
  });

  it("rebuilds when the file set changes", () => {
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    let calls = 0;
    const listImports = () => {
      calls += 1;
      return emptyImports();
    };
    const cache = new ImportGraphCache();
    cache.get(dir, { listImports });
    const afterFirst = calls;
    writeFileSync(join(dir, "b.ts"), "export {};\n");
    cache.get(dir, { listImports });
    expect(calls).toBeGreaterThan(afterFirst);
  });
});
