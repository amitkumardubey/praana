import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemTools } from "../src/tools/system.js";
import { ScorecardTracker } from "../src/context-engine/telemetry.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { openContextEngineDb } from "../src/context-engine/db.js";
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

describe("repeat-read (observe experiment: always disk)", () => {
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

  function makeTools() {
    return createSystemTools({
      cwd: testDir,
      skills: [],
      skillRuntime: null,
      getCurrentTurn: () => 3,
      onScorecardFileRead: (absPath, mtimeMs) => scorecard.trackReadPath(absPath, mtimeMs),
      clearReadPath: (absPath) => {
        scorecard.clearReadPath(absPath);
        store.clearFileRead(absPath);
      },
    });
  }

  it("second read returns file content from disk (no hard-block, no card)", async () => {
    const big = "x".repeat(2000);
    const rel = "big.txt";
    writeFileSync(join(testDir, rel), big);

    const tools = makeTools();
    const first = await tools.read_file.execute({ path: rel });
    expect(first.ok).toBe(true);
    expect((first as { content?: string }).content).toBe(big);

    const second = await tools.read_file.execute({ path: rel });
    expect(second.ok).toBe(true);
    expect((second as { skipped_disk?: boolean }).skipped_disk).not.toBe(true);
    expect((second as { content?: string }).content).toBe(big);
    expect((second as { content?: string }).content).not.toContain("[artifact:");
    // Scorecard still counts a repeat path for telemetry
    expect(scorecard.getCounters().repeatFileReads).toBe(1);
  });

  it("blockRepeatReads flag is ignored — still reads disk", async () => {
    writeFileSync(join(testDir, "a.txt"), "hello");
    const tools = createSystemTools({
      cwd: testDir,
      skills: [],
      skillRuntime: null,
      getCurrentTurn: () => 0,
      blockRepeatReads: true,
      onScorecardFileRead: (absPath, mtimeMs) => scorecard.trackReadPath(absPath, mtimeMs),
      hasReadPath: (absPath) => scorecard.hasReadPath(absPath),
    });

    const first = await tools.read_file.execute({ path: "a.txt" });
    expect(first.ok).toBe(true);

    const second = await tools.read_file.execute({ path: "a.txt" });
    expect(second.ok).toBe(true);
    expect((second as { content?: string }).content).toBe("hello");
  });

  it("write_file then read returns updated content", async () => {
    const abs = join(testDir, "mut.txt");
    writeFileSync(abs, "v1");
    const tools = makeTools();

    await tools.read_file.execute({ path: "mut.txt" });
    const write = await tools.write_file.execute({ path: "mut.txt", content: "v2" });
    expect(write.ok).toBe(true);

    const afterWrite = await tools.read_file.execute({ path: "mut.txt" });
    expect(afterWrite.ok).toBe(true);
    expect((afterWrite as { content?: string }).content).toBe("v2");
  });

  it("failed read does not register path — later successful read is fresh", async () => {
    const tools = makeTools();
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
    expect(scorecard.hasReadPath(abs)).toBe(true);
  });

  it("re-reads updated content when mtime changed since last successful read", async () => {
    const abs = join(testDir, "mtime.txt");
    writeFileSync(abs, "v1");
    const tools = makeTools();

    const first = await tools.read_file.execute({ path: "mtime.txt" });
    expect(first.ok).toBe(true);
    expect((first as { content?: string }).content).toBe("v1");

    await Bun.sleep(20);
    writeFileSync(abs, "v2-external");

    const second = await tools.read_file.execute({ path: "mtime.txt" });
    expect(second.ok).toBe(true);
    expect((second as { content?: string }).content).toBe("v2-external");
  });

  it("read_file description does not push retrieve_artifact", () => {
    const tools = makeTools();
    expect(tools.read_file.description).not.toMatch(/retrieve_artifact/i);
  });

  it("findFileReadArtifact still recovers after store reopen (dormant store)", async () => {
    const big = "y".repeat(2000);
    const abs = join(testDir, "resume.txt");
    writeFileSync(abs, big);

    const ingested = store.ingestToolResult({
      sourceTool: "read_file",
      command: abs,
      rawText: big,
      createdTurn: 2,
    });
    expect(ingested.artifactId).toBeDefined();

    store.close();
    store = ArtifactStore.open(dbPath, "sess-repeat", ENGINE_CONFIG);

    const recovered = store.findFileReadArtifact(abs);
    expect(recovered).not.toBeNull();
    expect(recovered!.id).toBe(ingested.artifactId);
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
    expect(tracker.getCounters().repeatFileReads).toBe(1);

    tracker.persistProgress();
    const resumed = new ScorecardTracker(db, "s1", true);
    resumed.restoreFromDb();
    expect(resumed.hasReadPath("/tmp/a")).toBe(true);

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
