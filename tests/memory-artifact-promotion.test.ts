import { describe, it, expect, afterEach } from "vitest";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { openContextEngineDb } from "../src/context-engine/db.js";
import { listHighValueArtifacts } from "../src/context-engine/db.js";
import { MemoryStore } from "../src/memory/store.js";
import { APP_AGENT_ID } from "../src/app-identity.js";
import type { ContextEngineConfig } from "../src/types.js";

const TEST_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 50, // small so test text becomes artifacts
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

function largeText(chars: number, marker = "data"): string {
  return marker.repeat(Math.ceil(chars / marker.length)).slice(0, chars);
}

describe("M4 artifact promotion — listing", () => {
  let store: ArtifactStore;

  afterEach(() => {
    store?.close();
  });

  it("lists artifacts with access_count >= threshold", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(800, "review-marker ");
    const ing = store.ingestToolResult({
      sourceTool: "shell",
      command: "npm test",
      rawText: raw,
      createdTurn: 1,
    });
    expect(ing.artifactId).toBeDefined();
    expect(ing.inlined).toBe(false);

    // Touch 2 times (access_count becomes 2)
    store.touchAccess(ing.artifactId!, 2);
    store.touchAccess(ing.artifactId!, 3);

    const hot = store.listHighValueArtifacts(2);
    expect(hot.length).toBe(1);
    expect(hot[0].id).toBe(ing.artifactId);
    expect(hot[0].accessCount).toBeGreaterThanOrEqual(2);
  });

  it("excludes artifacts below the threshold", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    const raw = largeText(800, "low-access ");
    const ing = store.ingestToolResult({
      sourceTool: "shell",
      command: "rg foo",
      rawText: raw,
      createdTurn: 1,
    });
    // access_count stays 0
    const hot = store.listHighValueArtifacts(2);
    expect(hot.length).toBe(0);
  });

  it("only returns artifacts from the current session", () => {
    store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    // Create one artifact for sess-1 and one for sess-2 in the SAME db
    // by writing directly. (ArtifactStore scopes by session_id internally.)
    const db = openContextEngineDb(":memory:");
    db.prepare(
      `INSERT INTO context_artifacts
        (id, sha256, session_id, source_tool, command, created_turn, raw_tokens, raw_text, summary, content_type, last_accessed_turn, access_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "art_otherSession",
      "abc123",
      "sess-other",
      "shell",
      "echo x",
      1,
      100,
      "other session text",
      "other summary",
      "other",
      1,
      5,
      Date.now(),
    );
    db.close();

    // Re-open on the same db path? In-memory SQLite is per-connection, so
    // we can't share state across ArtifactStore.open calls. Instead, verify
    // the SQL filter directly via listHighValueArtifacts using a fresh db.
    const db2 = openContextEngineDb(":memory:");
    db2.prepare(
      `INSERT INTO context_artifacts
        (id, sha256, session_id, source_tool, command, created_turn, raw_tokens, raw_text, summary, content_type, last_accessed_turn, access_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "art_thisSession",
      "abc123",
      "sess-1",
      "shell",
      "echo x",
      1,
      100,
      "this session text",
      "this summary",
      "other",
      1,
      5,
      Date.now(),
    );
    db2.prepare(
      `INSERT INTO context_artifacts
        (id, sha256, session_id, source_tool, command, created_turn, raw_tokens, raw_text, summary, content_type, last_accessed_turn, access_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "art_otherSession",
      "def456",
      "sess-2",
      "shell",
      "echo y",
      1,
      100,
      "other session text",
      "other summary",
      "other",
      1,
      5,
      Date.now(),
    );

    const hot = listHighValueArtifacts(db2, "sess-1", 2);
    expect(hot.map((a) => a.id)).toEqual(["art_thisSession"]);
    db2.close();
  });

  it("rejects minAccessCount < 1", () => {
    const db = openContextEngineDb(":memory:");
    expect(() => listHighValueArtifacts(db, "any", 0)).toThrow();
    expect(() => listHighValueArtifacts(db, "any", -1)).toThrow();
    db.close();
  });
});

describe("M4 artifact promotion — dedup with cross-session memory", () => {
  it("re-stating an already-promoted artifact reinforces rather than duplicates", async () => {
    const store = ArtifactStore.open(":memory:", "sess-1", TEST_CONFIG);
    try {
      const raw = largeText(800, "promote-me ");
      const ing = store.ingestToolResult({
        sourceTool: "shell",
        command: "rg review",
        rawText: raw,
        createdTurn: 1,
      });
      expect(ing.artifactId).toBeDefined();
      store.touchAccess(ing.artifactId!, 2);
      store.touchAccess(ing.artifactId!, 3);
      const hot = store.listHighValueArtifacts(2);
      expect(hot.length).toBe(1);

      // Simulate the promotion: call remember() with the artifact summary form.
      const memStore = new MemoryStore({
        dbPath: ":memory:",
        embedder: null,
        summarizer: null,
      });
      try {
        await memStore.sessionStart({
          agent: APP_AGENT_ID,
          user_id: "test-user",
          context_id: "test-context",
          time: Date.now(),
          context_label: "test",
        });

        const content = `[artifact:${hot[0].id}] ${hot[0].summary}`;
        const first = await memStore.remember(content, {
          kind: "fact",
          certainty: "medium",
        });
        expect(first.reinforced).toBeUndefined();
        expect(memStore.getEntryCount()).toBe(1);

        // Re-state the same artifact (e.g. from a second session's promotion).
        const second = await memStore.remember(content, {
          kind: "fact",
          certainty: "medium",
        });
        expect(second.reinforced).toBe(true);
        // Still one row — dedup merged it.
        expect(memStore.getEntryCount()).toBe(1);
      } finally {
        memStore.close();
      }
    } finally {
      store.close();
    }
  });

  it("an artifact with a freshly-issued summary creates a fresh memory entry", async () => {
    const memStore = new MemoryStore({
      dbPath: ":memory:",
      embedder: null,
      summarizer: null,
    });
    try {
      await memStore.sessionStart({
        agent: APP_AGENT_ID,
        user_id: "test-user",
        context_id: "test-context",
        time: Date.now(),
        context_label: "test",
      });
      const r1 = await memStore.remember(
        "[artifact:art_abc] Code review notes for module X",
        { kind: "fact", certainty: "medium" },
      );
      const r2 = await memStore.remember(
        "[artifact:art_def] Search results for query Y",
        { kind: "fact", certainty: "medium" },
      );
      expect(r1.id).not.toBe(r2.id);
      expect(memStore.getEntryCount()).toBe(2);
    } finally {
      memStore.close();
    }
  });
});