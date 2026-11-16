import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRuntime, buildSkillMetadataCatalog } from "../src/skills/index.js";
import { SkillStatsStore } from "../src/skills/skill-stats-store.js";
import { isSessionGood } from "../src/session-outcome.js";
import { openDatabase } from "../src/sqlite.js";
import { ensureSkillStatsTable, getSkillUsefulness } from "../src/memory/db.js";
import type { SkillsRuntimeConfig, SkillRecord } from "../src/skills/types.js";

let tmpBase: string;

function makeConfig(
  overrides: Partial<SkillsRuntimeConfig> & { searchPaths?: string[] } = {},
): SkillsRuntimeConfig {
  return {
    enabled: true,
    max_token_budget_ratio: 0.2,
    max_loaded_skills: 3,
    stale_threshold_turns: 10,
    max_depth: 6,
    searchPaths: [join(tmpBase, "skills")],
    ...overrides,
  };
}

function writeSkill(dir: string, name: string, description: string, body = "") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    "utf-8",
  );
}

beforeEach(() => {
  tmpBase = join(
    tmpdir(),
    `praana-skill-loop-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(tmpBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Used tracking
// ---------------------------------------------------------------------------

describe("SkillRuntime used tracking", () => {
  it("markResidentSkillsUsed marks loaded skills used and scorecard reflects it", async () => {
    const skillsDir = join(tmpBase, "skills");
    writeSkill(skillsDir, "X", "Skill X");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();

    rt.trackLoad("X", 1);
    rt.markResidentSkillsUsed();
    rt.cleanupStaleSkills(20); // evict X

    const effects = rt.getSkillEffects();
    expect(effects).toHaveLength(1);
    expect(effects[0].skillId).toBe("X");
    expect(effects[0].used).toBe(true);

    expect(rt.getSkillScorecard().used).toBe(1);
  });

  it("without markResidentSkillsUsed, effect has used=false and scorecard.used=0", async () => {
    const skillsDir = join(tmpBase, "skills");
    writeSkill(skillsDir, "X", "Skill X");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();

    rt.trackLoad("X", 1);
    rt.cleanupStaleSkills(20); // evict without marking used

    const effects = rt.getSkillEffects();
    expect(effects[0].used).toBe(false);
    expect(rt.getSkillScorecard().used).toBe(0);
  });

  it("usedSkills survives eviction — marked once, stays marked", async () => {
    const skillsDir = join(tmpBase, "skills");
    writeSkill(skillsDir, "X", "Skill X");

    const rt = new SkillRuntime(makeConfig({ stale_threshold_turns: 2 }), tmpBase);
    await rt.initialize();

    rt.trackLoad("X", 1);
    rt.markResidentSkillsUsed();
    rt.cleanupStaleSkills(5); // evicts X

    // Reload X — it's still in usedSkills from before
    rt.trackLoad("X", 6);
    const effects = rt.getSkillEffects();
    expect(effects[0].used).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Co-occurrence pairs
// ---------------------------------------------------------------------------

describe("SkillRuntime co-occurrence", () => {
  it("records pairs of co-resident skills at cleanupStaleSkills", async () => {
    const skillsDir = join(tmpBase, "skills");
    writeSkill(skillsDir, "alpha", "Alpha");
    writeSkill(skillsDir, "beta", "Beta");

    const rt = new SkillRuntime(makeConfig(), tmpBase);
    await rt.initialize();

    rt.trackLoad("alpha", 1);
    rt.trackLoad("beta", 2);
    rt.cleanupStaleSkills(3); // both still resident — pair recorded

    const pairs = rt.getCooccurrencePairs();
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual(["alpha", "beta"]);
  });
});

// ---------------------------------------------------------------------------
// SkillStatsStore end-to-end flush
// ---------------------------------------------------------------------------

describe("SkillStatsStore flush", () => {
  function makeDbPath() {
    return join(tmpBase, "memory.db");
  }

  it("session 1: used∧good=false → neutral (no change)", () => {
    // Raw good=false (e.g. aborted/error end) → all effects are neutral or decay.
    const dbPath = makeDbPath();
    // Pre-create the db + table
    const db = openDatabase(dbPath);
    ensureSkillStatsTable(db);
    db.close();

    const store = new SkillStatsStore(dbPath, "context:test");
    store.flush("sess-1", false /* good=false for 'clean' reason */, [
      { skillId: "X", scope: "context:test", loaded: true, used: true },
    ], []);

    const db2 = openDatabase(dbPath, { readonly: true, create: false });
    ensureSkillStatsTable(db2);
    const map = getSkillUsefulness(db2, "context:test");
    db2.close();

    // used∧¬good → neutral → usefulness unchanged at 0.5
    expect(map.get("X")).toBeCloseTo(0.5, 3);
  });

  it("decay: loaded but not used → usefulness decreases", () => {
    const dbPath = makeDbPath();
    const db = openDatabase(dbPath);
    ensureSkillStatsTable(db);
    db.close();

    const store = new SkillStatsStore(dbPath, "context:test");
    store.flush("sess-2", true, [
      { skillId: "Y", scope: "context:test", loaded: true, used: false },
    ], []);

    const db2 = openDatabase(dbPath, { readonly: true, create: false });
    ensureSkillStatsTable(db2);
    const map = getSkillUsefulness(db2, "context:test");
    db2.close();

    // ¬used → decay → 0.5 * 0.95 = 0.475
    expect(map.get("Y")).toBeCloseTo(0.475, 3);
  });

  it("sequential sessions: decay compounds", () => {
    const dbPath = makeDbPath();
    const db = openDatabase(dbPath);
    ensureSkillStatsTable(db);
    db.close();

    const store = new SkillStatsStore(dbPath, "context:test");
    // Session 1: loaded but not used → 0.5 * 0.95 = 0.475
    store.flush("sess-1", true, [
      { skillId: "Z", scope: "context:test", loaded: true, used: false },
    ], []);
    // Session 2: loaded but not used again → 0.475 * 0.95 ≈ 0.451
    store.flush("sess-2", true, [
      { skillId: "Z", scope: "context:test", loaded: true, used: false },
    ], []);

    const db2 = openDatabase(dbPath, { readonly: true, create: false });
    ensureSkillStatsTable(db2);
    const map = getSkillUsefulness(db2, "context:test");
    db2.close();

    expect(map.get("Z")).toBeCloseTo(0.475 * 0.95, 3);
  });

  it("loadUsefulness returns empty map when db file is absent", () => {
    const store = new SkillStatsStore(join(tmpBase, "nonexistent.db"), "context:test");
    const map = store.loadUsefulness();
    expect(map.size).toBe(0);
  });

  it("flush is a no-op when effects is empty", () => {
    const dbPath = makeDbPath();
    const store = new SkillStatsStore(dbPath, "context:test");
    // Should not throw even if db doesn't exist yet
    expect(() => store.flush("sess-x", false, [], [])).not.toThrow();
  });

  it("session ending with reason 'clean' and ok tool results is recorded as good", () => {
    // Drive the real flush path the way Session.end does: derive `good` from the
    // actual end reason + events via isSessionGood, then flush to skill_stats.
    const dbPath = makeDbPath();
    const db = openDatabase(dbPath);
    ensureSkillStatsTable(db);
    db.close();

    const endEvents = [{ type: "tool_result", result: { ok: true } }];
    const good = isSessionGood("clean", endEvents);
    expect(good).toBe(true);

    const store = new SkillStatsStore(dbPath, "context:test");
    store.flush("sess-clean", good, [
      { skillId: "C", scope: "context:test", loaded: true, used: true },
    ], []);

    const db2 = openDatabase(dbPath, { readonly: true, create: false });
    ensureSkillStatsTable(db2);
    const map = getSkillUsefulness(db2, "context:test");
    db2.close();

    // used∧good → boost → 0.5 + (1 − 0.5) * 0.15 = 0.575
    expect(map.get("C")).toBeCloseTo(0.575, 3);
  });
});

// ---------------------------------------------------------------------------
// isSessionGood — session-outcome classification
// ---------------------------------------------------------------------------

describe("isSessionGood", () => {
  const okTool: { type: string; result?: unknown } = {
    type: "tool_result",
    result: { ok: true },
  };
  const failingTool: { type: string; result?: unknown } = {
    type: "tool_result",
    result: { ok: false },
  };
  const userMsg: { type: string; result?: unknown } = {
    type: "user",
  };

  it("reason 'clean' with a tool_result result { ok: true } → true", () => {
    expect(isSessionGood("clean", [okTool])).toBe(true);
  });

  it("reason 'clean' with no events → true", () => {
    expect(isSessionGood("clean", undefined)).toBe(true);
    expect(isSessionGood("clean", [])).toBe(true);
  });

  it("reason 'aborted' → false regardless of events", () => {
    expect(isSessionGood("aborted", [okTool])).toBe(false);
    expect(isSessionGood("aborted", undefined)).toBe(false);
  });

  it("reason 'error' → false regardless of events", () => {
    expect(isSessionGood("error", [okTool])).toBe(false);
    expect(isSessionGood("error", undefined)).toBe(false);
  });

  it("reason 'normal' still behaves as before", () => {
    expect(isSessionGood("normal", [okTool])).toBe(true);
    expect(isSessionGood("normal", undefined)).toBe(true);
    expect(isSessionGood("normal", [failingTool])).toBe(false);
    expect(isSessionGood("normal", [userMsg])).toBe(false);
  });

  it("reason 'clean' with a failing tool_result → false", () => {
    expect(isSessionGood("clean", [failingTool])).toBe(false);
  });

  it("reason 'clean' with only a load_skill ok result → false", () => {
    const loadSkillOk: { type: string; result?: unknown; tool_name?: string } = {
      type: "tool_result",
      tool_name: "load_skill",
      result: { ok: true },
    };
    expect(isSessionGood("clean", [loadSkillOk])).toBe(false);
    expect(isSessionGood("clean", [userMsg, loadSkillOk])).toBe(false);
  });

  it("reason 'clean' with a load_skill ok result plus another tool ok → true", () => {
    const loadSkillOk: { type: string; result?: unknown; tool_name?: string } = {
      type: "tool_result",
      tool_name: "load_skill",
      result: { ok: true },
    };
    expect(isSessionGood("clean", [loadSkillOk, okTool])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSkillMetadataCatalog — usefulness ranking
// ---------------------------------------------------------------------------

describe("buildSkillMetadataCatalog ranking", () => {
  function makeRecord(name: string, description = "desc"): SkillRecord {
    return { name, description, location: `/skills/${name}.md`, directory: "/skills", body: "", metadata: { name, description }, scope: "" };
  }

  it("sorts by descending usefulness when map is provided", () => {
    const records = [makeRecord("a"), makeRecord("b"), makeRecord("c")];
    const usefulness = new Map([["a", 0.9], ["b", 0.3], ["c", 0.6]]);
    const catalog = buildSkillMetadataCatalog(records, usefulness);

    const aIdx = catalog.indexOf("**a**");
    const bIdx = catalog.indexOf("**b**");
    const cIdx = catalog.indexOf("**c**");

    expect(aIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(cIdx);  // a (0.9) before c (0.6)
    expect(cIdx).toBeLessThan(bIdx);  // c (0.6) before b (0.3)
  });

  it("falls back to discovery order when usefulness is empty", () => {
    const records = [makeRecord("x"), makeRecord("y"), makeRecord("z")];
    const catalog = buildSkillMetadataCatalog(records, new Map());

    const xIdx = catalog.indexOf("**x**");
    const yIdx = catalog.indexOf("**y**");
    const zIdx = catalog.indexOf("**z**");

    expect(xIdx).toBeLessThan(yIdx);
    expect(yIdx).toBeLessThan(zIdx);
  });

  it("falls back to discovery order when usefulness is undefined", () => {
    const records = [makeRecord("p"), makeRecord("q")];
    const catalog = buildSkillMetadataCatalog(records);
    expect(catalog.indexOf("**p**")).toBeLessThan(catalog.indexOf("**q**"));
  });

  it("unknown-usefulness skills default to 0.5 (middle rank)", () => {
    const records = [makeRecord("known"), makeRecord("unknown")];
    // known=0.9, unknown not in map → defaults to 0.5 → known ranks first
    const usefulness = new Map([["known", 0.9]]);
    const catalog = buildSkillMetadataCatalog(records, usefulness);
    expect(catalog.indexOf("**known**")).toBeLessThan(catalog.indexOf("**unknown**"));
  });
});
