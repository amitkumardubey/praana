import { describe, it, expect } from "bun:test";
import { openDatabase } from "../src/sqlite.js";
import {
  ensureSkillStatsTable,
  getSkillUsefulness,
  updateSkillUsefulness,
  bumpSkillStats,
  bumpSkillCooccurrence,
} from "../src/memory/db.js";

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

describe("ensureSkillStatsTable", () => {
  it("creates skill_stats and skill_cooccurrence tables", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("skill_stats");
    expect(names).toContain("skill_cooccurrence");
    db.close();
  });

  it("is idempotent — second call does not throw", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);
    expect(() => ensureSkillStatsTable(db)).not.toThrow();
    db.close();
  });
});

// ---------------------------------------------------------------------------
// getSkillUsefulness — dual-scope recall
// ---------------------------------------------------------------------------

describe("getSkillUsefulness", () => {
  it("returns empty map on fresh db", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);
    const map = getSkillUsefulness(db, "context:abc123");
    expect(map.size).toBe(0);
    db.close();
  });

  it("returns project-scoped rows for the given scope", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);
    bumpSkillStats(db, "context:repoA", "deploy", 1, 0, Date.now());
    bumpSkillStats(db, "context:repoB", "deploy", 1, 0, Date.now());

    const mapA = getSkillUsefulness(db, "context:repoA");
    expect(mapA.get("deploy")).toBeCloseTo(0.5, 3);

    const mapB = getSkillUsefulness(db, "context:repoB");
    expect(mapB.get("deploy")).toBeCloseTo(0.5, 3);
    db.close();
  });

  it("scope isolation — project scope does not leak into other project", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);

    // repoA boosted to 0.575
    bumpSkillStats(db, "context:repoA", "deploy", 1, 1, Date.now());
    updateSkillUsefulness(db, "context:repoA", "deploy", "boost");

    // repoB left at default 0.5
    bumpSkillStats(db, "context:repoB", "deploy", 1, 0, Date.now());

    const mapA = getSkillUsefulness(db, "context:repoA");
    const mapB = getSkillUsefulness(db, "context:repoB");

    expect(mapA.get("deploy")).toBeCloseTo(0.575, 3);
    expect(mapB.get("deploy")).toBeCloseTo(0.5, 3);
    db.close();
  });

  it("global scope rows appear in project-scoped reads (user-origin skills)", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);

    // A user-origin skill with scope="" has been boosted
    bumpSkillStats(db, "", "git-flow", 1, 1, Date.now());
    updateSkillUsefulness(db, "", "git-flow", "boost");

    const map = getSkillUsefulness(db, "context:anyProject");
    expect(map.get("git-flow")).toBeCloseTo(0.575, 3);
    db.close();
  });

  it("project scope overrides global on name collision", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);

    // Global: 0.5 default
    bumpSkillStats(db, "", "deploy", 1, 0, Date.now());

    // Project: boosted to 0.575
    bumpSkillStats(db, "context:myRepo", "deploy", 1, 1, Date.now());
    updateSkillUsefulness(db, "context:myRepo", "deploy", "boost");

    const map = getSkillUsefulness(db, "context:myRepo");
    expect(map.get("deploy")).toBeCloseTo(0.575, 3); // project wins
    db.close();
  });

  it("global-only read (empty projectScope) returns only global rows", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);

    bumpSkillStats(db, "", "shared-skill", 1, 0, Date.now());
    bumpSkillStats(db, "context:proj", "project-only", 1, 0, Date.now());

    const map = getSkillUsefulness(db, "");
    expect(map.has("shared-skill")).toBe(true);
    expect(map.has("project-only")).toBe(false);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// updateSkillUsefulness — boost / decay / neutral
// ---------------------------------------------------------------------------

describe("updateSkillUsefulness", () => {
  function makeRow(scope: string, skillId: string): { usefulness: number } {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);
    bumpSkillStats(db, scope, skillId, 1, 0, Date.now());
    return { usefulness: (getSkillUsefulness(db, scope).get(skillId) ?? 0.5) };
  }

  it("boost: u += (1-u)*0.15 starting from 0.5", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);
    bumpSkillStats(db, "", "skill-a", 1, 0, Date.now());
    updateSkillUsefulness(db, "", "skill-a", "boost");
    const map = getSkillUsefulness(db, "");
    // 0.5 + (1-0.5)*0.15 = 0.575
    expect(map.get("skill-a")).toBeCloseTo(0.575, 3);
    db.close();
  });

  it("decay: u *= (1-0.05) starting from 0.5", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);
    bumpSkillStats(db, "", "skill-b", 1, 0, Date.now());
    updateSkillUsefulness(db, "", "skill-b", "decay");
    const map = getSkillUsefulness(db, "");
    // 0.5 * 0.95 = 0.475
    expect(map.get("skill-b")).toBeCloseTo(0.475, 3);
    db.close();
  });

  it("neutral: no change to usefulness", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);
    bumpSkillStats(db, "", "skill-c", 1, 0, Date.now());
    updateSkillUsefulness(db, "", "skill-c", "neutral");
    const map = getSkillUsefulness(db, "");
    expect(map.get("skill-c")).toBeCloseTo(0.5, 3);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// bumpSkillCooccurrence
// ---------------------------------------------------------------------------

describe("bumpSkillCooccurrence", () => {
  it("inserts and increments co-occurrence pairs", () => {
    const db = openDatabase(":memory:");
    ensureSkillStatsTable(db);

    bumpSkillCooccurrence(db, "context:x", [["alpha", "beta"]]);
    bumpSkillCooccurrence(db, "context:x", [["alpha", "beta"]]);

    const row = db
      .query("SELECT count FROM skill_cooccurrence WHERE scope=? AND skill_a=? AND skill_b=?")
      .get("context:x", "alpha", "beta") as { count: number } | undefined;

    expect(row?.count).toBe(2);
    db.close();
  });
});
