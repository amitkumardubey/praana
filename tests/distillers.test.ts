import { describe, it, expect } from "vitest";
import { DiffDistiller } from "../src/distillers/git-diff.js";
import { GenericDistiller, LogDistiller } from "../src/distillers/generic.js";
import { TestDistiller } from "../src/distillers/npm-test.js";
import { BuildDistiller } from "../src/distillers/tsc-errors.js";
import { SearchDistiller } from "../src/distillers/rg-results.js";
import { createDefaultDistillerRegistry } from "../src/domain/coding-domain.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { DistillerRegistry, type Distiller } from "../src/context-engine/distiller.js";
import { estimateTokens } from "../src/context-engine/summarize.js";
import type { ContentType } from "../src/context-engine/types.js";
import type { ContextEngineConfig } from "../src/types.js";

const TEST_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 50,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

const SAMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,5 +1,6 @@
 import x from "x";
+const added = true;
 export function foo() {
   return 1;
 }
`;

const SAMPLE_TEST_FAIL = `FAIL tests/compiler.test.ts
  TypeError: Cannot read properties of undefined
    at Object.<anonymous> (compiler.test.ts:42:5)
PASS tests/other.test.ts
Test Suites: 1 failed, 1 passed, 2 total
Tests: 1 failed, 3 passed, 4 total`;

const SAMPLE_TSC = `src/a.ts(10,3): error TS2322: Type 'string' is not assignable to type 'number'.
src/b.ts(4,1): error TS2322: Type 'string' is not assignable to type 'number'.`;

const SAMPLE_RG = `src/a.ts:10:export function foo()
src/a.ts:20:export function fooHelper()
src/b.ts:3:export function bar()`;

const SAMPLE_VITEST_FAIL = ` FAIL  tests/math.test.ts > adds numbers
AssertionError: expected 2 to be 3

- Expected
+ Received

- 3
+ 2

 ❯ tests/math.test.ts:12:17
     10|   it("adds numbers", () => {
     11|     const result = add(1, 1);
     12|     expect(result).toBe(3);
       |                 ^

Test Files  1 failed (1)
     Tests  1 failed (1)`;

class FlakyDeferredLogDistiller implements Distiller {
  readonly name = "flaky-deferred-log";
  readonly contentTypes: ContentType[] = ["log"];
  readonly mode = "deferred" as const;

  distill(input: string): string {
    if (input.includes("first failure")) {
      throw new Error("distiller exploded");
    }
    return `deferred summary: ${input.split("\n")[0]}`;
  }
}

describe("distillers", () => {
  it("DiffDistiller keeps changed hunks with reduced context", () => {
    const out = new DiffDistiller().distill(SAMPLE_DIFF, "full");
    expect(out).toContain("+const added = true");
    expect(out).toContain("diff --git");
    expect(out.length).toBeLessThan(SAMPLE_DIFF.length);
  });

  it("TestDistiller surfaces failures and suite summary", () => {
    const out = new TestDistiller().distill(SAMPLE_TEST_FAIL, "full");
    expect(out).toContain("FAIL tests/compiler.test.ts");
    expect(out).toContain("TypeError");
    expect(out).toMatch(/failed|passed/i);
  });

  it("BuildDistiller deduplicates repeated TypeScript errors", () => {
    const full = new BuildDistiller().distill(SAMPLE_TSC, "full");
    expect(full).toContain("TS2322");
    expect(full).toContain("1 unique build error");
    expect(full).toContain("2 location");

    const lite = new BuildDistiller().distill(SAMPLE_TSC, "lite");
    expect(lite).toContain("src/a.ts:10");
    expect(lite).toContain("src/b.ts:4");
  });

  it("BuildDistiller preserves every location for repeated TypeScript errors", () => {
    const out = new BuildDistiller().distill(SAMPLE_TSC, "full");
    expect(out).toContain("src/a.ts:10");
    expect(out).toContain("src/b.ts:4");
  });

  it("TestDistiller preserves assertion diffs, code frames, and vitest stack frames", () => {
    const out = new TestDistiller().distill(SAMPLE_VITEST_FAIL, "full");
    expect(out).toContain("AssertionError: expected 2 to be 3");
    expect(out).toContain("- Expected");
    expect(out).toContain("+ Received");
    expect(out).toContain("❯ tests/math.test.ts:12:17");
    expect(out).toContain("expect(result).toBe(3)");
  });

  it("DiffDistiller keeps file metadata needed to understand non-hunk changes", () => {
    const input = `diff --git a/old.ts b/new.ts
similarity index 91%
rename from old.ts
rename to new.ts
index 111..222 100644
--- a/old.ts
+++ b/new.ts
@@ -1,3 +1,3 @@
 export const value = 1;
-export const name = "old";
+export const name = "new";`;
    const out = new DiffDistiller().distill(input, "full");
    expect(out).toContain("rename from old.ts");
    expect(out).toContain("rename to new.ts");
    expect(out).toContain("--- a/old.ts");
    expect(out).toContain("+++ b/new.ts");
  });

  it("DiffDistiller keeps metadata-only diffs in full mode", () => {
    const input = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts`;
    const out = new DiffDistiller().distill(input, "full");
    expect(out).toContain("similarity index 100%");
    expect(out).toContain("rename from old.ts");
    expect(out).toContain("rename to new.ts");
  });

  it("SearchDistiller caps and deduplicates search output", () => {
    const input = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts:${i}:match`).join("\n");
    const out = new SearchDistiller().distill(input, "full");
    expect(out).toContain("showing 15 of 40");
    expect(out.split("\n").length).toBeLessThan(20);
  });

  it("GenericDistiller head/tail reduces large prose", () => {
    const input = "alpha ".repeat(500);
    const out = new GenericDistiller().distill(input, "full");
    expect(out).toContain("chars omitted");
    expect(out.length).toBeLessThan(input.length);
  });

  it("GenericDistiller keeps summarized JSON parseable", () => {
    const input = JSON.stringify({
      ok: true,
      items: Array.from({ length: 80 }, (_, i) => ({ id: i, name: `item-${i}` })),
    });
    const out = new GenericDistiller().distill(input, "full", "json");
    expect(() => JSON.parse(out)).not.toThrow();
    expect(out).toContain('"__praana_summary"');
  });

  it("LogDistiller aggregates repetitive log lines", () => {
    const lines = ["INFO starting", "INFO tick", "INFO tick", "ERROR boom"];
    const input = lines.join("\n").repeat(80);
    const out = new LogDistiller().distill(input, "full");
    expect(out).toContain("unique patterns");
    expect(out).toContain("ERROR boom");
  });

  it("registry selects specialized distillers by content type", () => {
    const registry = createDefaultDistillerRegistry();
    const result = registry.distillSync(SAMPLE_DIFF, "diff", "full");
    expect(result.distillerName).toBe("git-diff");
    expect(result.summary).toContain("+const added");
  });

  it("artifact ingestion infers rg output from shell command and uses SearchDistiller", () => {
    const store = ArtifactStore.open(":memory:", "sess-rg", TEST_CONFIG);
    const raw = Array.from({ length: 40 }, (_, i) => `src/f${i}.ts:${i}:match`).join("\n");
    const ingested = store.ingestToolResult({
      sourceTool: "shell",
      command: "rg match src",
      rawText: raw,
      createdTurn: 1,
    });

    const artifact = store.getArtifact(ingested.artifactId!);
    expect(artifact?.contentType).toBe("search_results");
    expect(artifact?.summary).toContain("Search results: showing 15 of 40");
    store.close();
  });

  it("deferred distillation keeps later jobs when one job fails", async () => {
    const registry = new DistillerRegistry();
    registry.register(new FlakyDeferredLogDistiller());
    const store = ArtifactStore.open(":memory:", "sess-deferred", TEST_CONFIG, registry);

    const failed = store.ingestToolResult({
      sourceTool: "shell",
      command: "bad logs",
      rawText: "first failure\n".repeat(200),
      contentType: "log",
      createdTurn: 1,
    });
    const successful = store.ingestToolResult({
      sourceTool: "shell",
      command: "good logs",
      rawText: "first success\n".repeat(200),
      contentType: "log",
      createdTurn: 1,
    });

    await expect(store.flushDeferredDistillation()).resolves.toBe(2);
    expect(store.getArtifact(failed.artifactId!)?.summary).toContain("compression failed");
    expect(store.getArtifact(successful.artifactId!)?.summary).toContain("deferred summary");
    store.close();
  });

  it("log distillation compresses synchronously", async () => {
    const store = ArtifactStore.open(":memory:", "sess-log", TEST_CONFIG);
    const raw = ["INFO worker", "INFO worker", "ERROR failed"].join("\n").repeat(200);
    const ingested = store.ingestToolResult({
      sourceTool: "shell",
      command: "npm run worker",
      rawText: raw,
      contentType: "log",
      createdTurn: 1,
    });
    // LogDistiller is sync — no pending marker
    expect(ingested.promptText).not.toContain("compression pending");
    expect(ingested.promptText).toContain("artifact:");

    const artifact = store.getArtifact(ingested.artifactId!);
    expect(artifact?.summary).not.toContain("compression pending");
    expect(estimateTokens(artifact!.summary)).toBeLessThan(estimateTokens(raw));
    store.close();
  });
});
