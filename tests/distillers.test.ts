import { describe, it, expect } from "vitest";
import { DiffDistiller } from "../src/distillers/git-diff.js";
import { GenericDistiller, LogDistiller } from "../src/distillers/generic.js";
import { TestDistiller } from "../src/distillers/npm-test.js";
import { BuildDistiller } from "../src/distillers/tsc-errors.js";
import { SearchDistiller } from "../src/distillers/rg-results.js";
import { createDefaultDistillerRegistry } from "../src/distillers/index.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { estimateTokens } from "../src/context-engine/summarize.js";
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
  scoring_enabled: true,
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
    expect(full).toContain("1 build error");

    const lite = new BuildDistiller().distill(SAMPLE_TSC, "lite");
    expect(lite).toContain("src/a.ts:10");
    expect(lite).toContain("src/b.ts:4");
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
