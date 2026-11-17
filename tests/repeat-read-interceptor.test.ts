import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSystemTools } from "../src/tools/system.js";
import { ScorecardTracker } from "../src/context-engine/telemetry.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import { openContextEngineDb } from "../src/context-engine/db.js";
import { rmForce } from "./helpers/platform.js";
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

describe("read_file repeat reads (#799)", () => {
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
    rmForce(testDir);
  });

  function makeTools() {
    return createSystemTools({
      cwd: testDir,
      skills: [],
      skillRuntime: null,
      getCurrentTurn: () => 3,
      getReadPathMtime: (absPath) => scorecard.getReadPathMtime(absPath),
      onScorecardFileRead: (absPath, mtimeMs, countAsRepeat) =>
        scorecard.trackReadPath(absPath, mtimeMs, countAsRepeat),
      clearReadPath: (absPath) => {
        scorecard.clearReadPath(absPath);
        store.clearFileReadAllRanges(absPath);
      },
    });
  }

  it("a second read of an unchanged file returns the full contents", async () => {
    const big = "x".repeat(2000);
    const abs = join(testDir, "big.txt");
    writeFileSync(abs, big);

    const tools = makeTools();
    const first = await tools.read_file.execute({ path: "big.txt" });
    expect(first.ok).toBe(true);
    expect((first as { content?: string }).content).toBe(big);

    const second = await tools.read_file.execute({ path: "big.txt" });
    expect(second.ok).toBe(true);
    expect((second as { content?: string }).content).toBe(big);
    expect((second as { warning?: string }).warning).toBeUndefined();
    // Telemetry still counts the repeat.
    expect(scorecard.getCounters().repeatFileReads).toBe(1);
  });

  it("a ranged re-read returns that range", async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n");
    writeFileSync(join(testDir, "range.txt"), lines);
    const tools = makeTools();

    const first = await tools.read_file.execute({ path: "range.txt", offset: 1, limit: 10 });
    expect(first.ok).toBe(true);
    expect((first as { content?: string }).content).toBe(
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10",
    );

    const again = await tools.read_file.execute({ path: "range.txt", offset: 1, limit: 10 });
    expect(again.ok).toBe(true);
    expect((again as { content?: string }).content).toBe(
      "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10",
    );

    const otherRange = await tools.read_file.execute({ path: "range.txt", offset: 11, limit: 10 });
    expect(otherRange.ok).toBe(true);
    expect((otherRange as { content?: string }).content).toBe(
      "line11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20",
    );
  });

  it("write_file invalidates the path so a subsequent read is fresh", async () => {
    const abs = join(testDir, "mut.txt");
    writeFileSync(abs, "v1");
    const tools = makeTools();

    await tools.read_file.execute({ path: "mut.txt" });
    await tools.read_file.execute({ path: "mut.txt" });

    const write = await tools.write_file.execute({ path: "mut.txt", content: "v2" });
    expect(write.ok).toBe(true);

    const afterWrite = await tools.read_file.execute({ path: "mut.txt" });
    expect(afterWrite.ok).toBe(true);
    expect((afterWrite as { content?: string }).content).toBe("v2");
    // Cleared path counts as a first read again — no additional repeat.
    expect(scorecard.getCounters().repeatFileReads).toBe(1);
  });

  it("re-reads from disk when mtime changed since last successful read", async () => {
    const abs = join(testDir, "mtime.txt");
    writeFileSync(abs, "v1");
    const tools = makeTools();

    const first = await tools.read_file.execute({ path: "mtime.txt" });
    expect((first as { content?: string }).content).toBe("v1");

    // External edit (not via write_file) — deterministically bump mtime.
    const nextMtime = new Date(statSync(abs).mtimeMs + 2000);
    writeFileSync(abs, "v2-external");
    utimesSync(abs, nextMtime, nextMtime);

    const second = await tools.read_file.execute({ path: "mtime.txt" });
    expect(second.ok).toBe(true);
    expect((second as { content?: string }).content).toBe("v2-external");
    expect(scorecard.getCounters().repeatFileReads).toBe(0);
  });

  it("read_file works without artifact or read-path helpers (classic)", async () => {
    writeFileSync(join(testDir, "c.txt"), "classic");
    const tools = createSystemTools({
      cwd: testDir,
      skills: [],
      skillRuntime: null,
      getCurrentTurn: () => 0,
    });

    const first = await tools.read_file.execute({ path: "c.txt" });
    expect(first.ok).toBe(true);
    expect((first as { content?: string }).content).toBe("classic");
    const second = await tools.read_file.execute({ path: "c.txt" });
    expect(second.ok).toBe(true);
    expect((second as { content?: string }).content).toBe("classic");
  });

  it("failed read does not register the path — later successful read is fresh", async () => {
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

  it("read_file description no longer points at retrieve_artifact", () => {
    const tools = makeTools();
    expect(tools.read_file.description).not.toMatch(/retrieve_artifact/i);
  });

  it("rejects zero and non-integer read ranges", () => {
    const tools = makeTools();

    expect(tools.read_file.parameters.safeParse({ path: "range.txt", offset: 0 }).success).toBe(false);
    expect(tools.read_file.parameters.safeParse({ path: "range.txt", limit: 0 }).success).toBe(false);
    expect(tools.read_file.parameters.safeParse({ path: "range.txt", limit: 1.5 }).success).toBe(false);
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
    rmForce(dir);
  });
});
