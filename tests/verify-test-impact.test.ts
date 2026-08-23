import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildReverseImportGraph } from "../src/verify/import-graph.js";
import {
  isTestFile,
  runAffectedTests,
  selectAffectedTests,
} from "../src/verify/test-impact.js";
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

describe("isTestFile", () => {
  it("matches *.test.* and *.spec.*", () => {
    expect(isTestFile("/x/foo.test.ts")).toBe(true);
    expect(isTestFile("/x/foo.spec.ts")).toBe(true);
    expect(isTestFile("/x/foo.ts")).toBe(false);
  });
});

describe("selectAffectedTests", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-sel-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("includes the edited file when it is a test, plus importing tests", () => {
    const src = join(dir, "src.ts");
    const test = join(dir, "src.test.ts");
    writeFileSync(src, "export {};\n");
    writeFileSync(test, 'import "./src.js";\n');
    const graph = buildReverseImportGraph(dir, {
      listImports: (path) =>
        path === test ? importsOf("./src.js") : emptyImports(),
    });
    expect(selectAffectedTests(src, graph).sort()).toEqual([test]);
    expect(selectAffectedTests(test, graph)).toEqual([test]);
  });
});

describe("runAffectedTests", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(
      tmpdir(),
      `praana-run-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips with none_affected when no test imports the file", async () => {
    const src = join(dir, "src.ts");
    writeFileSync(src, "export {};\n");
    const result = await runAffectedTests(src, dir, {
      listImports: () => emptyImports(),
      runTests: async () => {
        throw new Error("should not run");
      },
    });
    expect(result.skipped).toBe("none_affected");
  });

  it("skips with too_many and lists the first N paths", async () => {
    const src = join(dir, "src.ts");
    writeFileSync(src, "export {};\n");
    const tests: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = join(dir, `a${i}.test.ts`);
      writeFileSync(t, `import "./src.js";\n`);
      tests.push(t);
    }
    const result = await runAffectedTests(src, dir, {
      listImports: (path) =>
        path.endsWith(".test.ts") ? importsOf("./src.js") : emptyImports(),
      maxTestFiles: 2,
      runTests: async () => {
        throw new Error("should not run");
      },
    });
    expect(result.skipped).toBe("too_many");
    expect(result.files).toHaveLength(2);
    expect(tests).toEqual(expect.arrayContaining(result.files ?? []));
  });

  it("skips with no_runner when runTests is missing", async () => {
    const test = join(dir, "src.test.ts");
    writeFileSync(test, "export {};\n");
    const result = await runAffectedTests(test, dir, {
      listImports: () => emptyImports(),
      bunAvailable: false,
    });
    expect(result.skipped).toBe("no_runner");
    expect(result.files).toEqual([test]);
  });

  it("returns injected runner results", async () => {
    const test = join(dir, "src.test.ts");
    writeFileSync(test, "export {};\n");
    const result = await runAffectedTests(test, dir, {
      listImports: () => emptyImports(),
      runTests: async (files) => ({
        passed: 0,
        failed: 1,
        files,
        failures: [
          { name: "breaks", file: files[0] ?? "", message: "expected 1" },
        ],
      }),
    });
    expect(result.failed).toBe(1);
    expect(result.failures?.[0]?.name).toBe("breaks");
    expect(result.files).toEqual([test]);
  });
});
