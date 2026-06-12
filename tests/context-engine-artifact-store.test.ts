import { describe, it, expect, afterEach } from "vitest";
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
  scoring_enabled: true,
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

  it("reuses artifact card for repeated read_file on same path", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(3000);
    const first = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw,
      createdTurn: 1,
    });
    const second = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/foo.ts",
      rawText: raw + "changed",
      createdTurn: 2,
    });
    expect(second.artifactId).toBe(first.artifactId);
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
});
