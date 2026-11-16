/**
 * skill_stats / skill_cooccurrence table helpers (stored in memory.db).
 */

import type { Database } from "bun:sqlite";

/**
 * Create skill_stats and skill_cooccurrence tables.
 * Idempotent via CREATE TABLE IF NOT EXISTS — safe to call on a bare openDatabase()
 * connection.
 */
export function ensureSkillStatsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_stats (
      skill_id         TEXT NOT NULL,
      scope            TEXT NOT NULL DEFAULT '',
      usefulness       REAL NOT NULL DEFAULT 0.5,
      load_count       INTEGER NOT NULL DEFAULT 0,
      used_count       INTEGER NOT NULL DEFAULT 0,
      last_loaded_at   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (skill_id, scope)
    );
    CREATE TABLE IF NOT EXISTS skill_cooccurrence (
      scope    TEXT NOT NULL DEFAULT '',
      skill_a  TEXT NOT NULL,
      skill_b  TEXT NOT NULL,
      count    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (scope, skill_a, skill_b)
    );
  `);
}

/** Skill utility update constants. */
const SKILL_UTILITY_ALPHA_USE = 0.15;
const SKILL_UTILITY_BETA_IDLE = 0.05;

/**
 * Read per-skill usefulness scores for both the project scope and the global scope ("").
 * Dual-scope lookup: global rows are loaded first (as fallback),
 * then project-scoped rows overwrite on name collision so project-learned values win.
 * Pass `projectScope = ""` when there is no project context (global-only lookup).
 */
export function getSkillUsefulness(
  db: Database,
  projectScope: string,
): Map<string, number> {
  const out = new Map<string, number>();
  // 1. Global rows first (lower priority)
  const globalRows = db
    .query("SELECT skill_id, usefulness FROM skill_stats WHERE scope = ''")
    .all() as Array<{ skill_id: string; usefulness: number }>;
  for (const row of globalRows) out.set(row.skill_id, row.usefulness);
  // 2. Project-scoped rows override global (if projectScope is non-empty and distinct)
  if (projectScope && projectScope !== "") {
    const projectRows = db
      .query("SELECT skill_id, usefulness FROM skill_stats WHERE scope = ?")
      .all(projectScope) as Array<{ skill_id: string; usefulness: number }>;
    for (const row of projectRows) out.set(row.skill_id, row.usefulness);
  }
  return out;
}

/**
 * Apply a delta update to a single skill's usefulness in skill_stats.
 * boost: u += (1-u)*α   decay: u *= (1-β)   neutral: no-op
 */
export function updateSkillUsefulness(
  db: Database,
  scope: string,
  skillId: string,
  mode: "boost" | "decay" | "neutral",
): void {
  if (mode === "neutral") return;
  if (mode === "boost") {
    db.query(
      `UPDATE skill_stats SET usefulness = MIN(1.0, usefulness + (1.0 - usefulness) * ?)
       WHERE skill_id = ? AND scope = ?`,
    ).run(SKILL_UTILITY_ALPHA_USE, skillId, scope);
  } else {
    db.query(
      `UPDATE skill_stats SET usefulness = usefulness * (1.0 - ?)
       WHERE skill_id = ? AND scope = ?`,
    ).run(SKILL_UTILITY_BETA_IDLE, skillId, scope);
  }
}

/**
 * Insert or update load/used counters and last_loaded_at for a skill.
 * loaded/used are increments (0 or 1 each).
 */
export function bumpSkillStats(
  db: Database,
  scope: string,
  skillId: string,
  loaded: number,
  used: number,
  now: number,
): void {
  db.query(
    `INSERT INTO skill_stats (skill_id, scope, usefulness, load_count, used_count, last_loaded_at)
     VALUES (?, ?, 0.5, ?, ?, ?)
     ON CONFLICT(skill_id, scope) DO UPDATE SET
       load_count = load_count + excluded.load_count,
       used_count = used_count + excluded.used_count,
       last_loaded_at = MAX(last_loaded_at, excluded.last_loaded_at)`,
  ).run(skillId, scope, loaded, used, now);
}

/**
 * Bump co-occurrence count for a pair of skills (a < b lexicographically).
 */
export function bumpSkillCooccurrence(
  db: Database,
  scope: string,
  pairs: Array<[string, string]>,
): void {
  for (const [a, b] of pairs) {
    db.query(
      `INSERT INTO skill_cooccurrence (scope, skill_a, skill_b, count)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(scope, skill_a, skill_b) DO UPDATE SET count = count + 1`,
    ).run(scope, a, b);
  }
}
