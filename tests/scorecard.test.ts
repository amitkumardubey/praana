import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  ScorecardTracker,
  createNullScorecard,
} from "../src/context-engine/telemetry.js";
import { openContextEngineDb } from "../src/context-engine/db.js";

describe("ScorecardTracker", () => {
  let dbPath: string;
  let db: Database.Database;

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

  function createDb(): Database.Database {
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
    expect(counters.skillsUsed).toBe(0);
    expect(counters.skillUnderloadEvents).toBe(1);
    expect(counters.skillReloadCount).toBe(2);
    expect(counters.skillTokensConsumed).toBe(500);
  });

  it("flush() writes exactly one row with correct values", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    // Increment some counters
    tracker.inc("artifactRetrieveCalls", 2);
    tracker.inc("totalTurns", 3);
    tracker.inc("recallCalls", 5);
    tracker.inc("skillsLoaded", 1);
    tracker.setSkillsUsed(1);

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
  });

  it("a second flush() upserts rather than errors", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.inc("totalTurns", 3);
    await tracker.flush(undefined, 0);

    // Second flush — should upsert, not error
    // Counter is accumulated: 3 + 5 = 8
    tracker.inc("totalTurns", 5);
    await tracker.flush(undefined, 0);

    const row = db
      .prepare("SELECT total_turns FROM scorecard WHERE session_id = ?")
      .get("test-session") as { total_turns: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.total_turns).toBe(8);
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

  it("restoreFromDb preserves memory start averages across resume", async () => {
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
    const tracker = new ScorecardTracker(db, "test-session", true);
    await tracker.recordMemoryStart(memDbPath);
    tracker.inc("totalTurns", 1);
    tracker.persistProgress();

    const resumed = new ScorecardTracker(db, "test-session", true);
    resumed.restoreFromDb();
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
    expect(row).toBeDefined();
    expect(row!.context_engine_on).toBe(0);
  });

  it("null-object pattern: inc() and flush() are no-ops when db is null", async () => {
    const nullTracker = createNullScorecard();
    expect(nullTracker.getCounters().totalTurns).toBe(0);

    // These should not throw
    nullTracker.inc("totalTurns", 5);
    await nullTracker.flush(undefined, 0);

    // Still zero because null-object
    expect(nullTracker.getCounters().totalTurns).toBe(0);
  });

  it("recordMemoryStart/end snapshots memory averages when memory db is provided", async () => {
    // Create a memory DB with some entries
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
    const tracker = new ScorecardTracker(db, "test-session", true);

    await tracker.recordMemoryStart(memDbPath);
    await tracker.flush(memDbPath, 0);

    const row = db
      .prepare("SELECT * FROM scorecard WHERE session_id = ?")
      .get("test-session") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.validity_avg_start).toBeCloseTo(0.7, 1);
    expect(row!.usefulness_avg_start).toBeCloseTo(0.6, 1);
    expect(row!.validity_avg_end).toBeCloseTo(0.7, 1);
    expect(row!.usefulness_avg_end).toBeCloseTo(0.6, 1);

    memDb.close();
    rmSync(memDbPath, { force: true });
  });

  it("setSkillsUsed and setSkillUnderloadEvents are reflected in flush", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.setSkillsUsed(3);
    tracker.setSkillUnderloadEvents(2);

    // Also inc the regular skill counters
    tracker.inc("skillsLoaded", 5);
    tracker.inc("skillReloadCount", 1);
    tracker.inc("skillTokensConsumed", 1200);

    await tracker.flush(undefined, 0);

    const row = db
      .prepare("SELECT * FROM scorecard WHERE session_id = ?")
      .get("test-session") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.skills_used).toBe(3);
    expect(row!.skill_underload_events).toBe(2);
    expect(row!.skills_loaded).toBe(5);
    expect(row!.skill_reload_count).toBe(1);
    expect(row!.skill_tokens_consumed).toBe(1200);
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

  it("applySkillSnapshot overwrites skill counters for session-end sync", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    tracker.applySkillSnapshot({
      loaded: 5,
      used: 3,
      reloaded: 2,
      underload: 1,
      tokensConsumed: 900,
    });

    const counters = tracker.getCounters();
    expect(counters.skillsLoaded).toBe(5);
    expect(counters.skillsUsed).toBe(3);
    expect(counters.skillReloadCount).toBe(2);
    expect(counters.skillUnderloadEvents).toBe(1);
    expect(counters.skillTokensConsumed).toBe(900);
  });

  it("recall_used_count must be snapshotted before pending_reinforcements flush", async () => {
    const db = createDb();
    const tracker = new ScorecardTracker(db, "test-session", true);

    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_reinforcements (
        entry_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (entry_id, session_id)
      )
    `);
    db.prepare(
      "INSERT INTO pending_reinforcements (entry_id, session_id, ts, used) VALUES (?, ?, ?, ?)",
    ).run("e1", "test-session", Date.now(), 1);
    db.prepare(
      "INSERT INTO pending_reinforcements (entry_id, session_id, ts, used) VALUES (?, ?, ?, ?)",
    ).run("e2", "test-session", Date.now(), 0);

    const usedBeforeFlush = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM pending_reinforcements WHERE session_id = ? AND used = 1",
        )
        .get("test-session") as { c: number }
    ).c;
    expect(usedBeforeFlush).toBe(1);

    db.prepare("DELETE FROM pending_reinforcements WHERE session_id = ?").run("test-session");

    await tracker.flush(undefined, usedBeforeFlush);

    const row = db
      .prepare("SELECT recall_used_count FROM scorecard WHERE session_id = ?")
      .get("test-session") as { recall_used_count: number } | undefined;
    expect(row?.recall_used_count).toBe(1);
  });
});

describe("Scorecard schema privacy invariant", () => {
  it("no TEXT column in scorecard table except session_id and TEXT-type fields", () => {
    // Scorecard should only have INTEGER, REAL, or TEXT PRIMARY KEY session_id
    const dbPath = join(mkdtempSync(join(tmpdir(), "praana-schema-")), "context.db");
    const db = openContextEngineDb(dbPath);

    const columns = db
      .prepare("PRAGMA table_info(scorecard)")
      .all() as Array<{ name: string; type: string; pk: number }>;

    for (const col of columns) {
      if (col.name === "session_id") {
        // session_id is TEXT PRIMARY KEY — that's allowed
        continue;
      }
      // All other columns must be INTEGER or REAL
      expect(["INTEGER", "REAL"]).toContain(col.type);
    }

    db.close();
    rmSync(dbPath, { force: true });
  });
});

describe("End-to-end: minimal session with retrieve_artifact", () => {
  it("records artifact_retrieve_calls after retrieve_artifact usage", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "praana-e2e-")), "context.db");
    const db = openContextEngineDb(dbPath);

    const tracker = new ScorecardTracker(db, "test-session", true);

    // Simulate: user makes a turn that calls retrieve_artifact
    tracker.inc("totalTurns", 1);
    tracker.inc("artifactRetrieveCalls", 1);
    tracker.inc("turnEventSearches");
    tracker.inc("recallCalls", 3);

    await tracker.flush(undefined, 2);

    const row = db
      .prepare("SELECT * FROM scorecard WHERE session_id = ?")
      .get("test-session") as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!.artifact_retrieve_calls).toBe(1);
    expect(row!.total_turns).toBe(1);
    expect(row!.turn_event_searches).toBe(1);
    expect(row!.recall_calls).toBe(3);
    expect(row!.recall_used_count).toBe(2);

    db.close();
    rmSync(dbPath, { force: true });
  });
});
