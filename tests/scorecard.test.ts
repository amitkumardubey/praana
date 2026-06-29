import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ScorecardTracker,
  createNullScorecard,
} from "../src/context-engine/telemetry.js";
import { openContextEngineDb } from "../src/context-engine/db.js";
import { getMemorySignalAverages } from "../src/memory/db.js";

function memoryAveragesProvider(contextScope?: string) {
  return (memoryDbPath: string) => {
    const memDb = new Database(memoryDbPath, { readonly: true });
    try {
      return getMemorySignalAverages(memDb, contextScope);
    } finally {
      memDb.close();
    }
  };
}

describe("ScorecardTracker", () => {
  let dbPath: string;
  let db: Database;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // ignore
    }
    try {
      rmSync(dbPath, { force: true });
    } catch {
      // ignore
    }
  });

  function createDb(): Database {
    dbPath = join(mkdtempSync(join(tmpdir(), "praana-scorecard-")), "context.db");
    db = openContextEngineDb(dbPath);
    return db;
  }

  it("initializes with zero counters", () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);
    const counters = tracker.getCounters();
    expect(counters.artifactRetrieveCalls).toBe(0);
    expect(counters.artifactCardsProduced).toBe(0);
    expect(counters.repeatFileReads).toBe(0);
    expect(counters.decisionContradictions).toBe(0);
    expect(counters.turnEventSearches).toBe(0);
    expect(counters.totalTurns).toBe(0);
    expect(counters.pressureEvents).toBe(0);
    expect(counters.compactionTriggers).toBe(0);
    expect(counters.recallCalls).toBe(0);
    expect(counters.recallUsedCount).toBe(0);
    expect(counters.skillsLoaded).toBe(0);
    expect(counters.skillLoadEvents).toBe(0);
    expect(counters.skillsUsed).toBe(0);
    expect(counters.skillUnderloadEvents).toBe(0);
    expect(counters.skillReloadCount).toBe(0);
    expect(counters.skillTokensConsumed).toBe(0);
  });

  it("each inc() call increments the right field", () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.inc("artifactRetrieveCalls");
    tracker.inc("artifactCardsProduced", 3);
    tracker.inc("repeatFileReads");
    tracker.inc("decisionContradictions", 2);
    tracker.inc("turnEventSearches");
    tracker.inc("totalTurns", 5);
    tracker.inc("pressureEvents");
    tracker.inc("compactionTriggers");
    tracker.inc("recallCalls", 7);
    tracker.inc("skillsLoaded", 3);
    tracker.inc("skillLoadEvents", 4);
    tracker.inc("skillUnderloadEvents");
    tracker.inc("skillReloadCount", 2);
    tracker.inc("skillTokensConsumed", 500);

    const counters = tracker.getCounters();
    expect(counters.artifactRetrieveCalls).toBe(1);
    expect(counters.artifactCardsProduced).toBe(3);
    expect(counters.repeatFileReads).toBe(1);
    expect(counters.decisionContradictions).toBe(2);
    expect(counters.turnEventSearches).toBe(1);
    expect(counters.totalTurns).toBe(5);
    expect(counters.pressureEvents).toBe(1);
    expect(counters.compactionTriggers).toBe(1);
    expect(counters.recallCalls).toBe(7);
    expect(counters.skillsLoaded).toBe(3);
    expect(counters.skillLoadEvents).toBe(4);
    expect(counters.skillsUsed).toBe(0);
    expect(counters.skillUnderloadEvents).toBe(1);
    expect(counters.skillReloadCount).toBe(2);
    expect(counters.skillTokensConsumed).toBe(500);
  });

  it("trackSkillLoad counts unique loads, reloads, and tokens", () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.trackSkillLoad("git", 100);
    tracker.trackSkillLoad("aws", 200);
    tracker.trackSkillLoad("git", 100);

    const counters = tracker.getCounters();
    expect(counters.skillsLoaded).toBe(2);
    expect(counters.skillLoadEvents).toBe(3);
    expect(counters.skillReloadCount).toBe(1);
    expect(counters.skillsUsed).toBe(2);
    expect(counters.skillTokensConsumed).toBe(400);
  });

  it("trackReadPath detects repeat reads and restores digests on resume", () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.trackReadPath("/tmp/a.txt");
    tracker.trackReadPath("/tmp/b.txt");
    tracker.trackReadPath("/tmp/a.txt");
    expect(tracker.getCounters().repeatFileReads).toBe(1);
    tracker.persistProgress();

    const resumed = new ScorecardTracker(db, "test-session", true);
    resumed.restoreFromDb();
    resumed.trackReadPath("/tmp/a.txt");
    expect(resumed.getCounters().repeatFileReads).toBe(2);
  });

  it("flush() writes exactly one row with correct values", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.inc("artifactRetrieveCalls", 2);
    tracker.inc("totalTurns", 3);
    tracker.inc("recallCalls", 5);
    tracker.trackSkillLoad("git", 50);

    await tracker.flush(undefined, 3);

    const row = db
      .prepare("SELECT * FROM scorecard WHERE session_id = ?")
      .get("test-session") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.artifact_retrieve_calls).toBe(2);
    expect(row!.context_engine_on).toBe(1);
    expect(row!.total_turns).toBe(3);
    expect(row!.recall_calls).toBe(5);
    expect(row!.recall_used_count).toBe(3);
    expect(row!.skills_loaded).toBe(1);
    expect(row!.skills_used).toBe(1);
    expect(row!.skill_load_events).toBe(1);
  });

  it("a second flush() upserts rather than errors", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.inc("totalTurns", 3);
    await tracker.flush(undefined, 0);

    tracker.inc("totalTurns", 5);
    await tracker.flush(undefined, 0);

    const row = db
      .prepare("SELECT total_turns FROM scorecard WHERE session_id = ?")
      .get("test-session") as { total_turns: number } | undefined;
    expect(row?.total_turns).toBe(8);
  });

  it("persistProgress + restoreFromDb survives simulated resume", () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.inc("totalTurns", 2);
    tracker.inc("recallCalls", 4);
    tracker.persistProgress();

    const resumed = new ScorecardTracker(db, "test-session", true);
    expect(resumed.restoreFromDb()).toBe(true);
    expect(resumed.getCounters().totalTurns).toBe(2);
    expect(resumed.getCounters().recallCalls).toBe(4);

    resumed.inc("totalTurns", 1);
    resumed.persistProgress();

    const row = db
      .prepare("SELECT total_turns, recall_calls FROM scorecard WHERE session_id = ?")
      .get("test-session") as { total_turns: number; recall_calls: number } | undefined;
    expect(row?.total_turns).toBe(3);
    expect(row?.recall_calls).toBe(4);
  });

  it("restoreFromDb preserves memory start averages and skips recordMemoryStart", async () => {
    const memDbPath = join(mkdtempSync(join(tmpdir(), "praana-mem-resume-")), "memory.db");
    const memDb = new Database(memDbPath);
    memDb.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'fact',
        content TEXT NOT NULL,
        validity REAL NOT NULL DEFAULT 0.5,
        usefulness REAL NOT NULL DEFAULT 0.5,
        pinned INTEGER NOT NULL DEFAULT 0,
        retracted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        session_id TEXT NOT NULL
      );
      INSERT INTO entries (id, kind, content, validity, usefulness, pinned, retracted, created_at, last_seen_at, session_id)
      VALUES ('e1', 'fact', 'entry 1', 0.9, 0.8, 0, 0, 1000, 1000, 's1');
    `);

    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true, {
      memoryAverages: memoryAveragesProvider(),
    });
    await tracker.recordMemoryStart(memDbPath);
    tracker.inc("totalTurns", 1);
    tracker.persistProgress();

    const resumed = new ScorecardTracker(db, "test-session", true, {
      memoryAverages: memoryAveragesProvider(),
    });
    resumed.restoreFromDb();
    await resumed.recordMemoryStart(memDbPath);

    const row = db
      .prepare("SELECT validity_avg_start FROM scorecard WHERE session_id = ?")
      .get("test-session") as { validity_avg_start: number } | undefined;
    expect(row?.validity_avg_start).toBeCloseTo(0.9, 1);

    memDb.close();
    rmSync(memDbPath, { force: true });
  });

  it("classic mode with measurement_mode=true creates row with context_engine_on=0", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", false);

    tracker.inc("totalTurns", 2);
    await tracker.flush(undefined, 0);

    const row = db
      .prepare("SELECT context_engine_on FROM scorecard WHERE session_id = ?")
      .get("test-session") as { context_engine_on: number } | undefined;
    expect(row?.context_engine_on).toBe(0);
  });

  it("null-object pattern: inc() and flush() are no-ops when db is null", async () => {
    const nullTracker = createNullScorecard();
    expect(nullTracker.getCounters().totalTurns).toBe(0);

    nullTracker.inc("totalTurns", 5);
    await nullTracker.flush(undefined, 0);

    expect(nullTracker.getCounters().totalTurns).toBe(0);
  });

  it("recordMemoryStart/end snapshots memory averages when provider is configured", async () => {
    const memDbPath = join(mkdtempSync(join(tmpdir(), "praana-mem-")), "memory.db");
    const memDb = new Database(memDbPath);
    memDb.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'fact',
        content TEXT NOT NULL,
        validity REAL NOT NULL DEFAULT 0.5,
        usefulness REAL NOT NULL DEFAULT 0.5,
        pinned INTEGER NOT NULL DEFAULT 0,
        retracted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        session_id TEXT NOT NULL
      );
      INSERT INTO entries (id, kind, content, validity, usefulness, pinned, retracted, created_at, last_seen_at, session_id)
      VALUES ('e1', 'fact', 'entry 1', 0.8, 0.7, 0, 0, 1000, 1000, 's1');
      INSERT INTO entries (id, kind, content, validity, usefulness, pinned, retracted, created_at, last_seen_at, session_id)
      VALUES ('e2', 'fact', 'entry 2', 0.6, 0.5, 0, 0, 1001, 1001, 's1');
    `);

    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true, {
      memoryAverages: memoryAveragesProvider(),
    });

    await tracker.recordMemoryStart(memDbPath);
    await tracker.flush(memDbPath, 0);

    const row = db
      .prepare("SELECT * FROM scorecard WHERE session_id = ?")
      .get("test-session") as Record<string, unknown> | undefined;
    expect(row?.validity_avg_start).toBeCloseTo(0.7, 1);
    expect(row?.usefulness_avg_start).toBeCloseTo(0.6, 1);
    expect(row?.validity_avg_end).toBeCloseTo(0.7, 1);
    expect(row?.usefulness_avg_end).toBeCloseTo(0.6, 1);

    memDb.close();
    rmSync(memDbPath, { force: true });
  });

  it("setRecallUsedCount is reflected in getCounters and flush", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.setRecallUsedCount(4);
    expect(tracker.getCounters().recallUsedCount).toBe(4);

    await tracker.flush(undefined, 4);
    const row = db
      .prepare("SELECT recall_used_count FROM scorecard WHERE session_id = ?")
      .get("test-session") as { recall_used_count: number } | undefined;
    expect(row?.recall_used_count).toBe(4);
  });

  it("applySkillSnapshot overwrites skill counters for session-end sync", () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.applySkillSnapshot({
      loaded: 2,
      loadEvents: 4,
      used: 2,
      reloaded: 2,
      underload: 1,
      tokensConsumed: 900,
      skillIds: ["git", "aws"],
    });

    const counters = tracker.getCounters();
    expect(counters.skillsLoaded).toBe(2);
    expect(counters.skillLoadEvents).toBe(4);
    expect(counters.skillsUsed).toBe(2);
    expect(counters.skillReloadCount).toBe(2);
    expect(counters.skillUnderloadEvents).toBe(1);
    expect(counters.skillTokensConsumed).toBe(900);
  });

  it("recall_used_count must be snapshotted before pending_reinforcements flush", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    const usedBeforeFlush = 1;
    await tracker.flush(undefined, usedBeforeFlush);

    const row = db
      .prepare("SELECT recall_used_count FROM scorecard WHERE session_id = ?")
      .get("test-session") as { recall_used_count: number } | undefined;
    expect(row?.recall_used_count).toBe(1);
  });
});

describe("Scorecard schema privacy invariant", () => {
  const ALLOWED_TEXT_COLUMNS = new Set([
    "session_id",
    "read_path_digests",
    "skills_ever_loaded",
  ]);

  it("stores only numeric metrics plus digests and skill catalog ids", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "praana-schema-")), "context.db");
    const db = openContextEngineDb(dbPath);

    const columns = db
      .prepare("PRAGMA table_info(scorecard)")
      .all() as Array<{ name: string; type: string }>;

    for (const col of columns) {
      if (ALLOWED_TEXT_COLUMNS.has(col.name)) continue;
      expect(["INTEGER", "REAL"]).toContain(col.type);
    }

    db.close();
    rmSync(dbPath, { force: true });
  });
});

describe("getMemorySignalAverages", () => {
  it("scopes averages to a context scope when provided", () => {
    const memDbPath = join(mkdtempSync(join(tmpdir(), "praana-mem-scope-")), "memory.db");
    const memDb = new Database(memDbPath);
    memDb.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'fact',
        content TEXT NOT NULL,
        validity REAL NOT NULL DEFAULT 0.5,
        usefulness REAL NOT NULL DEFAULT 0.5,
        pinned INTEGER NOT NULL DEFAULT 0,
        retracted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        session_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entry_scopes (
        entry_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        PRIMARY KEY (entry_id, scope)
      );
      INSERT INTO entries VALUES ('e1', 'fact', 'project', 0.9, 0.8, 0, 0, 1, 1, 's1');
      INSERT INTO entries VALUES ('e2', 'fact', 'global', 0.1, 0.1, 0, 0, 1, 1, 's1');
      INSERT INTO entry_scopes VALUES ('e1', 'context:proj');
      INSERT INTO entry_scopes VALUES ('e2', 'context:other');
    `);

    const scoped = getMemorySignalAverages(memDb, "context:proj");
    expect(scoped.validityAvg).toBeCloseTo(0.9, 1);

    const global = getMemorySignalAverages(memDb);
    expect(global.validityAvg).toBeCloseTo(0.5, 1);

    memDb.close();
    rmSync(memDbPath, { force: true });
  });
});

describe("End-to-end: minimal session with retrieve_artifact", () => {
  it("records artifact_retrieve_calls after retrieve_artifact usage", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "praana-e2e-")), "context.db");
    const db = openContextEngineDb(dbPath);

    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.inc("totalTurns", 1);
    tracker.inc("artifactRetrieveCalls", 1);
    tracker.inc("turnEventSearches");
    tracker.inc("recallCalls", 3);

    await tracker.flush(undefined, 2);

    const row = db
      .prepare("SELECT * FROM scorecard WHERE session_id = ?")
      .get("test-session") as Record<string, unknown> | undefined;
    expect(row?.artifact_retrieve_calls).toBe(1);
    expect(row?.total_turns).toBe(1);
    expect(row?.turn_event_searches).toBe(1);
    expect(row?.recall_calls).toBe(3);
    expect(row?.recall_used_count).toBe(2);

    db.close();
    rmSync(dbPath, { force: true });
  });
});
