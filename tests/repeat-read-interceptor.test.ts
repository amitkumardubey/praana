import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemTools } from "../src/tools/system.js";
import { ScorecardTracker } from "../src/context-engine/telemetry.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { openContextEngineDb } from "../src/context-engine/db.js";
import { buildArtifactCard } from "../src/context-engine/summarize.js";
import type { ContextEngineConfig } from "../src/types.js";

const ENGINE_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 50,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3, w_semantic: 0.3, w_hydrate_boost: 0.2 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

describe("repeat-read interceptor", () => {
  let testDir: string;
  let dbPath: string;
  let store: ArtifactStore;
  let scorecard: ScorecardTracker;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "praana-repeat-read-"));
    dbPath = join(testDir, "context.db");
    store = ArtifactStore.open(dbPath, "sess-repeat", ENGINE_CONFIG);
    scorecard = new ScorecardTracker(store.getDb(), "sess-repeat", true);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // ignore
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeTools(opts: { blockRepeatReads?: boolean } = {}) {
    return createSystemTools({
      cwd: testDir,
      skills: [],
      skillRuntime: null,
      getCurrentTurn: () => 3,
      blockRepeatReads: opts.blockRepeatReads ?? false,
      hasReadPath: (absPath) => scorecard.hasReadPath(absPath),
      getReadPathMtime: (absPath) => scorecard.getReadPathMtime(absPath),
      onScorecardFileRead: (absPath, mtimeMs) => scorecard.trackReadPath(absPath, mtimeMs),
      clearReadPath: (absPath) => {
        scorecard.clearReadPath(absPath);
        store.clearFileReadAllRanges(absPath);
      },
      findFileReadArtifact: (absPath) => {
        const art = store.findFileReadArtifact(absPath);
        if (!art) return null;
        return {
          id: art.id,
          createdTurn: art.createdTurn,
          card: buildArtifactCard(
            art.id,
            art.sourceTool,
            art.command,
            art.rawTokens,
          ),
        };
      },
      findFileReadArtifactByRange: (absPath, offset, limit) => {
        const art = store.findFileReadArtifactByRange(absPath, offset, limit);
        if (!art) return null;
        return {
          id: art.id,
          createdTurn: art.createdTurn,
          card: buildArtifactCard(
            art.id,
            art.sourceTool,
            art.command,
            art.rawTokens,
          ),
        };
      },
    });
  }

  it("warn mode: second read returns artifact card without re-reading disk", async () => {
    const big = "x".repeat(2000);
    const rel = "big.txt";
    const abs = join(testDir, rel);
    writeFileSync(abs, big);

    const tools = makeTools();
    const first = await tools.read_file.execute({ path: rel });
    expect(first.ok).toBe(true);
    expect((first as { content?: string }).content).toBe(big);

    // Simulate turn ingest indexing the artifact under abs path
    const ingested = store.ingestToolResult({
      sourceTool: "read_file",
      command: abs,
      rawText: big,
      createdTurn: 3,
      sourceLineStart: 1,
      sourceLineEnd: 1,
      requestUnbounded: true,
    });
    expect(ingested.inlined).toBe(false);
    expect(ingested.artifactId).toBeDefined();

    const second = await tools.read_file.execute({ path: rel });
    expect(second.ok).toBe(true);
    expect((second as { skipped_disk?: boolean }).skipped_disk).toBe(true);
    expect((second as { warning?: string }).warning).toContain("Already read");
    expect((second as { warning?: string }).warning).toContain(ingested.artifactId!);
    expect((second as { warning?: string }).warning).toContain("turn 3");
    expect((second as { content?: string }).content).toContain(`[artifact: ${ingested.artifactId}`);
    expect((second as { content?: string }).content).not.toContain(big);
    expect(scorecard.getCounters().repeatFileReads).toBe(1);
  });

  it("block mode: second read returns ok:false for exact same file and range", async () => {
    writeFileSync(join(testDir, "a.txt"), "hello");
    const tools = makeTools({ blockRepeatReads: true });

    const first = await tools.read_file.execute({ path: "a.txt" });
    expect(first.ok).toBe(true);

    // Ingest to simulate engine processing, which stores the artifact
    store.ingestToolResult({
      sourceTool: "read_file",
      command: join(testDir, "a.txt"),
      rawText: "hello",
      createdTurn: 1,
      sourceLineStart: 1,
      sourceLineEnd: 1,
      requestUnbounded: true,
    });

    const second = await tools.read_file.execute({ path: "a.txt" });
    expect(second.ok).toBe(false);
    expect((second as { error?: string }).error).toMatch(/already read|repeat/i);
    expect(scorecard.getCounters().repeatFileReads).toBe(1);
  });

  it("write_file invalidates path so a subsequent read is fresh", async () => {
    const abs = join(testDir, "mut.txt");
    writeFileSync(abs, "v1");
    const tools = makeTools();

    await tools.read_file.execute({ path: "mut.txt" });
    store.ingestToolResult({
      sourceTool: "read_file",
      command: abs,
      rawText: "v1",
      createdTurn: 1,
      sourceLineStart: 1,
      sourceLineEnd: 1,
      requestUnbounded: true,
    });

    const blocked = await tools.read_file.execute({ path: "mut.txt" });
    expect((blocked as { skipped_disk?: boolean }).skipped_disk).toBe(true);

    const write = await tools.write_file.execute({ path: "mut.txt", content: "v2" });
    expect(write.ok).toBe(true);

    const afterWrite = await tools.read_file.execute({ path: "mut.txt" });
    expect(afterWrite.ok).toBe(true);
    expect((afterWrite as { skipped_disk?: boolean }).skipped_disk).not.toBe(true);
    expect((afterWrite as { content?: string }).content).toBe("v2");
  });

  it("does not crash when artifact lookup is absent (classic)", async () => {
    writeFileSync(join(testDir, "c.txt"), "classic");
    const tools = createSystemTools({
      cwd: testDir,
      skills: [],
      skillRuntime: null,
      getCurrentTurn: () => 0,
      blockRepeatReads: false,
      onScorecardFileRead: (absPath) => scorecard.trackReadPath(absPath),
      hasReadPath: (absPath) => scorecard.hasReadPath(absPath),
    });

    const first = await tools.read_file.execute({ path: "c.txt" });
    expect(first.ok).toBe(true);
    const second = await tools.read_file.execute({ path: "c.txt" });
    expect(second.ok).toBe(true);
    expect((second as { warning?: string }).warning).toMatch(/Already read/i);
    expect(scorecard.getCounters().repeatFileReads).toBe(1);
  });

  it("failed read does not register path — later successful read is fresh", async () => {
    const tools = makeTools({ blockRepeatReads: true });
    const missing = "missing-then-created.txt";
    const abs = join(testDir, missing);

    const failed = await tools.read_file.execute({ path: missing });
    expect(failed.ok).toBe(false);
    expect(scorecard.hasReadPath(abs)).toBe(false);
    expect(scorecard.getCounters().repeatFileReads).toBe(0);

    writeFileSync(abs, "now exists");
    const ok = await tools.read_file.execute({ path: missing });
    expect(ok.ok).toBe(true);
    expect((ok as { content?: string }).content).toBe("now exists");
    expect((ok as { skipped_disk?: boolean }).skipped_disk).not.toBe(true);
    expect(scorecard.hasReadPath(abs)).toBe(true);
  });

  it("findFileReadArtifact recovers after store reopen (resume)", async () => {
    const big = "y".repeat(2000);
    const abs = join(testDir, "resume.txt");
    writeFileSync(abs, big);

    const ingested = store.ingestToolResult({
      sourceTool: "read_file",
      command: abs,
      rawText: big,
      createdTurn: 2,
      sourceLineStart: 1,
      sourceLineEnd: 1,
      requestUnbounded: true,
    });
    expect(ingested.artifactId).toBeDefined();
    expect(store.findFileReadArtifact(abs)?.id).toBe(ingested.artifactId);

    store.close();
    store = ArtifactStore.open(dbPath, "sess-repeat", ENGINE_CONFIG);
    scorecard = new ScorecardTracker(store.getDb(), "sess-repeat", true);

    const recovered = store.findFileReadArtifact(abs);
    expect(recovered).not.toBeNull();
    expect(recovered!.id).toBe(ingested.artifactId);

    // Interceptor should return the artifact card, not a generic hint
    scorecard.trackReadPath(abs);
    const tools = makeTools();
    const second = await tools.read_file.execute({ path: "resume.txt" });
    expect(second.ok).toBe(true);
    expect((second as { skipped_disk?: boolean }).skipped_disk).toBe(true);
    expect((second as { artifact_id?: string }).artifact_id).toBe(ingested.artifactId);
    expect((second as { content?: string }).content).toContain(`[artifact: ${ingested.artifactId}`);
  });

  it("re-reads from disk when mtime changed since last successful read", async () => {
    const abs = join(testDir, "mtime.txt");
    writeFileSync(abs, "v1");
    const tools = makeTools();

    const first = await tools.read_file.execute({ path: "mtime.txt" });
    expect(first.ok).toBe(true);
    expect((first as { content?: string }).content).toBe("v1");
    store.ingestToolResult({
      sourceTool: "read_file",
      command: abs,
      rawText: "v1",
      createdTurn: 1,
    });

    // External edit (not via write_file) — bump mtime
    await Bun.sleep(20);
    writeFileSync(abs, "v2-external");

    const second = await tools.read_file.execute({ path: "mtime.txt" });
    expect(second.ok).toBe(true);
    expect((second as { skipped_disk?: boolean }).skipped_disk).not.toBe(true);
    expect((second as { content?: string }).content).toBe("v2-external");
    expect(scorecard.getCounters().repeatFileReads).toBe(0);
  });

  it("read_file description mentions retrieve_artifact", () => {
    const tools = makeTools();
    expect(tools.read_file.description).toMatch(/retrieve_artifact/i);
  });

  it("range-aware: different range is a fresh read, not a repeat", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");
    writeFileSync(join(testDir, "range.txt"), lines);
    const tools = makeTools();

    // First read: lines 1-10
    const first = await tools.read_file.execute({ path: "range.txt", offset: 1, limit: 10 });
    expect(first.ok).toBe(true);
    expect(first.content).toBe("line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10");

    // Ingest the artifact so it's stored
    store.ingestToolResult({
      sourceTool: "read_file",
      command: join(testDir, "range.txt"),
      rawText: first.content!,
      createdTurn: 1,
      sourceLineStart: 1,
      sourceLineEnd: 10,
    });

    // Different range should be a fresh read (not returned as repeat/cached)
    const differentRange = await tools.read_file.execute({ path: "range.txt", offset: 11, limit: 10 });
    expect(differentRange.ok).toBe(true);
    expect(differentRange.skipped_disk).not.toBe(true);
    expect(differentRange.content).toBe("line11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20");
  });

  it("range-aware: same range returns cached artifact", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");
    writeFileSync(join(testDir, "same-range.txt"), lines);
    const tools = makeTools();

    // First read: lines 1-10
    const first = await tools.read_file.execute({ path: "same-range.txt", offset: 1, limit: 10 });
    expect(first.ok).toBe(true);

    // Ingest the artifact
    const ingested = store.ingestToolResult({
      sourceTool: "read_file",
      command: join(testDir, "same-range.txt"),
      rawText: first.content!,
      createdTurn: 1,
      sourceLineStart: 1,
      sourceLineEnd: 10,
    });

    // Same range again should return cached artifact (skip disk)
    const sameRange = await tools.read_file.execute({ path: "same-range.txt", offset: 1, limit: 10 });
    expect(sameRange.ok).toBe(true);
    expect(sameRange.skipped_disk).toBe(true);
    expect(sameRange.artifact_id).toBe(ingested.artifactId);
    expect(sameRange.content).toContain(`[artifact: ${ingested.artifactId}`);
    expect(scorecard.getCounters().repeatFileReads).toBe(1);
  });
});

describe("ScorecardTracker read-path helpers", () => {
  it("hasReadPath and clearReadPath work without breaking resume digests", () => {
    const dir = mkdtempSync(join(tmpdir(), "praana-scorecard-rp-"));
    const dbPath = join(dir, "c.db");
    const db = openContextEngineDb(dbPath);
    const tracker = new ScorecardTracker(db, "s1", true);

    expect(tracker.hasReadPath("/tmp/a")).toBe(false);
    tracker.trackReadPath("/tmp/a");
    expect(tracker.hasReadPath("/tmp/a")).toBe(true);
    tracker.trackReadPath("/tmp/a");
    expect(tracker.getCounters().repeatFileReads).toBe(1);

    tracker.clearReadPath("/tmp/a");
    expect(tracker.hasReadPath("/tmp/a")).toBe(false);
    tracker.trackReadPath("/tmp/a");
    // Cleared path counts as first read again — no additional repeat
    expect(tracker.getCounters().repeatFileReads).toBe(1);

    tracker.persistProgress();
    const resumed = new ScorecardTracker(db, "s1", true);
    resumed.restoreFromDb();
    expect(resumed.hasReadPath("/tmp/a")).toBe(true);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
