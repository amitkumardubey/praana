import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { classifyContentType } from "../src/context-engine/classify.js";
import type { ContextEngineConfig } from "../src/types.js";

const TEST_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 400,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

function largeText(chars: number): string {
  return "x".repeat(chars);
}

describe("context-engine artifact store", () => {
  let store: ArtifactStore;

  afterEach(() => {
    store?.close();
  });

  it("inlines small tool outputs verbatim", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const result = store.ingestToolResult({
      sourceTool: "shell",
      command: "echo hi",
      rawText: "hello",
      createdTurn: 1,
    });
    expect(result.inlined).toBe(true);
    expect(result.promptText).toBe("hello");
    expect(result.artifactId).toBeUndefined();
  });

  it("stores large outputs as artifact cards", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(2000);
    const result = store.ingestToolResult({
      sourceTool: "shell",
      command: "npm test",
      rawText: raw,
      createdTurn: 2,
    });

    expect(result.inlined).toBe(false);
    expect(result.artifactId).toMatch(/^art_[a-f0-9]{12}$/);
    expect(result.promptText).toContain(result.artifactId!);
    expect(result.promptText).toContain('retrieve_artifact("');
    expect(result.promptText).not.toContain(raw);
  });

  it("deduplicates identical content by sha256", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(2500);
    const first = store.ingestToolResult({
      sourceTool: "shell",
      rawText: raw,
      createdTurn: 1,
    });
    const second = store.ingestToolResult({
      sourceTool: "read_file",
      command: "/tmp/foo.txt",
      rawText: raw,
      createdTurn: 2,
    });
    expect(second.artifactId).toBe(first.artifactId);
  });

  it("never compresses error content", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = "Error: something failed\n".repeat(200);
    const result = store.ingestToolResult({
      sourceTool: "shell",
      rawText: raw,
      contentType: "error",
      createdTurn: 1,
    });
    expect(result.inlined).toBe(true);
    expect(result.promptText).toBe(raw);
  });

  it("does not persist retrieve_artifact envelopes as source artifacts (idempotency/nesting guard)", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(2000);
    const ingested = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw,
      createdTurn: 1,
    });
    const beforeCount = store.countArtifacts();

    // A mis-routed retrieve_artifact result must not mint a new source artifact
    // whose content is the JSON envelope — that would cause recursive nesting.
    const envelope = JSON.stringify({ ok: true, id: ingested.artifactId, content: raw });
    const result = store.ingestToolResult({
      sourceTool: "retrieve_artifact",
      rawText: envelope,
      createdTurn: 2,
    });

    expect(result.inlined).toBe(true);
    expect(result.promptText).toBe(raw);
    expect(result.artifactId).toBeUndefined();
    expect(store.countArtifacts()).toBe(beforeCount);
  });

  it("retrieves raw artifact content with optional slicing", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = "line1\nline2\nline3\nline4";
    const ingested = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/a.ts",
      rawText: raw.repeat(200),
      createdTurn: 3,
    });
    const full = store.retrieve(ingested.artifactId!, 3);
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.content.length).toBeGreaterThan(100);
    }

    const sliced = store.retrieve(ingested.artifactId!, 4, {
      lineStart: 2,
      lineEnd: 2,
    });
    expect(sliced).toEqual({ ok: true, content: "line2" });
  });

  it("repeated retrievals return equivalent source content and do not mint nested artifacts", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const pad = "x".repeat(600);
    const raw = [`line1${pad}`, `line2${pad}`, `line3${pad}`, `line4${pad}`, `line5${pad}`].join("\n");
    const ingested = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw,
      createdTurn: 1,
    });
    expect(ingested.artifactId).toBeDefined();
    const id = ingested.artifactId!;

    // Full retrieval.
    const full1 = store.retrieve(id, 2);
    expect(full1).toEqual({ ok: true, content: raw });

    // Line-range retrieval returns exact original lines.
    const lines2to4 = store.retrieve(id, 3, { lineStart: 2, lineEnd: 4 });
    expect(lines2to4).toEqual({
      ok: true,
      content: [`line2${pad}`, `line3${pad}`, `line4${pad}`].join("\n"),
    });

    // Grep retrieval.
    const grep = store.retrieve(id, 4, { grep: "line[135]" });
    expect(grep).toEqual({
      ok: true,
      content: [`line1${pad}`, `line3${pad}`, `line5${pad}`].join("\n"),
    });

    // Second full retrieval is still equivalent to the original source.
    const full2 = store.retrieve(id, 5);
    expect(full2).toEqual({ ok: true, content: raw });

    // No new artifacts were created by retrievals.
    expect(store.countArtifacts()).toBe(1);

    // Each retrieval increments access_count by exactly 1 (no double-counting);
    // 4 retrievals → access_count 4 (insert starts at 0).
    expect(store.getArtifact(id)!.accessCount).toBe(4);
  });

  it("reuses artifact card for unchanged read_file but creates a new one when content changes", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(3000);
    const first = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw,
      createdTurn: 1,
    });
    const same = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw,
      createdTurn: 2,
    });
    expect(same.artifactId).toBe(first.artifactId);

    const changed = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw + "changed",
      createdTurn: 3,
    });
    expect(changed.artifactId).not.toBe(first.artifactId);
  });

  it("reuses the original artifact when content changes back to a previous hash", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(3000);
    const first = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw,
      createdTurn: 1,
    });
    store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw + "changed",
      createdTurn: 2,
    });
    const reverted = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw,
      createdTurn: 3,
    });

    expect(reverted.artifactId).toBe(first.artifactId);
  });

  it("evicts stale artifacts by ttl", () => {
    store = ArtifactStore.open(":memory:", "sess-1", {
      ...TEST_CONFIG,
      artifact_ttl_turns: 5,
    });
    const ingested = store.ingestToolResult({
      sourceTool: "shell",
      rawText: largeText(2500),
      createdTurn: 1,
    });
    expect(store.getArtifact(ingested.artifactId!)).not.toBeNull();

    const evicted = store.runEviction(10);
    expect(evicted).toBe(1);
    expect(store.getArtifact(ingested.artifactId!)).toBeNull();
  });

  it("classifies common content types", () => {
    expect(classifyContentType("diff --git a/foo b/foo\n@@ -1 +1 @@")).toBe("diff");
    expect(classifyContentType('{"ok":true}')).toBe("json");
    expect(classifyContentType("FAIL tests/a.test.ts\n✓ 2 passed")).toBe("test_output");
  });

  it("classifyContentType scans only the first 4K chars — a deep PASS does not misclassify", () => {
    // Regression (#275): a 53M-char search result containing "PASS" at
    // position 42.9M was classified as test_output and "distilled" into a
    // summary larger than the input.
    const head = "src/a.ts:1:export function foo()\n".repeat(200); // ~6.6K chars
    const text = `${head}\nPASS tests/foo.test.ts\nTests: 1 passed`;
    expect(text.length).toBeGreaterThan(4096);
    expect(classifyContentType(text)).not.toBe("test_output");
  });

  it("classifyContentType still detects test output within the 4K head window", () => {
    const text = `PASS tests/foo.test.ts\nTests: 1 passed\n${"x\n".repeat(5000)}`;
    expect(classifyContentType(text)).toBe("test_output");
  });

  it("artifact cards are bounded stubs that embed no raw content", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(5000);
    const ingested = store.ingestToolResult({
      sourceTool: "shell",
      command: "make all",
      rawText: raw,
      createdTurn: 1,
    });
    expect(ingested.inlined).toBe(false);
    expect(ingested.promptText).toMatch(
      /^\[artifact: art_[a-f0-9]{12} \| shell: make all \| [\d,]+ tokens raw\]\nRetrieve: retrieve_artifact\("art_[a-f0-9]{12}"\)$/,
    );
    expect(ingested.promptText.length).toBeLessThan(200);
    expect(ingested.promptText).not.toContain(raw.slice(0, 100));
    // Full bytes remain retrievable on demand.
    const retrieved = store.retrieve(ingested.artifactId!, 1);
    expect(retrieved.ok).toBe(true);
    expect((retrieved as { ok: true; content: string }).content).toBe(raw);
  });

  it("lists read_file artifacts via listFileReads", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    store.ingestToolResult({
      sourceTool: "shell",
      command: "npm test",
      rawText: largeText(3000),
      createdTurn: 1,
    });
    const read = store.ingestToolResult({
      sourceTool: "read_file",
      command: "/proj/src/auth.ts",
      rawText: largeText(3001),
      createdTurn: 3,
    });

    const reads = store.listFileReads();
    expect(reads.length).toBe(1);
    expect(reads[0].absPath).toBe("/proj/src/auth.ts");
    expect(reads[0].artifactId).toBe(read.artifactId);
    expect(reads[0].createdTurn).toBe(3);
  });

  it("listFileReads excludes non-read_file artifacts and is sorted by createdTurn descending", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    store.ingestToolResult({ sourceTool: "read_file", command: "/proj/a.ts", rawText: largeText(3001), createdTurn: 1 });
    store.ingestToolResult({ sourceTool: "shell", command: "echo hi", rawText: "hello", createdTurn: 2 });
    store.ingestToolResult({ sourceTool: "read_file", command: "/proj/b.ts", rawText: largeText(3002), createdTurn: 5 });
    store.ingestToolResult({ sourceTool: "read_file", command: "/proj/c.ts", rawText: largeText(3003), createdTurn: 3 });

    const reads = store.listFileReads();
    expect(reads.length).toBe(3);
    expect(reads.map((r) => r.absPath)).toEqual(["/proj/b.ts", "/proj/c.ts", "/proj/a.ts"]);
    expect(reads[0].createdTurn).toBe(5);
    expect(reads[1].createdTurn).toBe(3);
    expect(reads[2].createdTurn).toBe(1);
  });

  it("does not hand back another session's artifact for identical content", () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-art-"));
    const dbPath = join(dir, "memory.db");
    try {
      const raw = largeText(2500);
      const sessionA = ArtifactStore.open(dbPath, "sess-A", TEST_CONFIG);
      const fromA = sessionA.ingestToolResult({
        sourceTool: "read_file",
        command: "/tmp/foo.txt",
        rawText: raw,
        createdTurn: 1,
      });
      sessionA.close();

      const sessionB = ArtifactStore.open(dbPath, "sess-B", TEST_CONFIG);
      const fromB = sessionB.ingestToolResult({
        sourceTool: "read_file",
        command: "/tmp/foo.txt",
        rawText: raw,
        createdTurn: 1,
      });

      // Same content, different session -> distinct artifact ids (no PK clash).
      expect(fromB.artifactId).not.toBe(fromA.artifactId);
      // The id minted in session B must be retrievable in session B.
      const retrieved = sessionB.retrieve(fromB.artifactId!, 2);
      expect(retrieved.ok).toBe(true);
      sessionB.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retrieve returns error when lineStart exceeds content line count", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(2000);
    const ingested = store.ingestToolResult({
      sourceTool: "shell",
      rawText: raw,
      createdTurn: 1,
    });
    expect(ingested.artifactId).toBeDefined();
    const result = store.retrieve(ingested.artifactId!, 1, { lineStart: 10 });
    expect(result.ok).toBe(false);
    expect((result as { error?: string }).error).toMatch(/lineStart.*exceeds/);
    store.close();
  });
});
