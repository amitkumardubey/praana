/**
 * SkillStatsStore — cross-session skill usefulness persistence.
 *
 * Reads learned usefulness from skill_stats (memory.db) at session start,
 * and flushes boost/decay transitions at session end (engine mode only).
 * Uses dual-scope recall: project-scoped rows override global ("") rows,
 * mirroring memory's recall pattern so user-origin skills are also ranked.
 */

import { openDatabase } from "../sqlite.js";
import {
  ensureSkillStatsTable,
  getSkillUsefulness,
  updateSkillUsefulness,
  bumpSkillStats,
  bumpSkillCooccurrence,
} from "../memory/db.js";
import { getAppLogger } from "../logger.js";
import type { SkillEffect } from "./types.js";

export class SkillStatsStore {
  constructor(
    private readonly dbPath: string | null,
    private readonly projectScope: string,
  ) {}

  /**
   * Load usefulness scores for all skills (dual-scope: global + project).
   * Returns empty map when dbPath is null, or when skill_stats doesn't exist yet
   * (first session — table is created lazily by flush, not here).
   */
  loadUsefulness(): Map<string, number> {
    if (!this.dbPath) return new Map();
    try {
      const db = openDatabase(this.dbPath, { readonly: true, create: false });
      try {
        // No ensureSkillStatsTable here — it's a CREATE (write) and this handle is
        // readonly. If the table is absent (first session), getSkillUsefulness
        // throws "no such table" which the outer catch handles gracefully.
        return getSkillUsefulness(db, this.projectScope);
      } finally {
        db.close();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "no such table" is expected on first run — log at debug, not warn.
      if (msg.includes("no such table")) {
        getAppLogger().child("skills").debug("skill_stats table not yet created — first session");
      } else {
        getAppLogger().child("skills").warn("Failed to load skill usefulness", { cause: err as Error });
      }
      return new Map();
    }
  }

  /**
   * Flush skill effectiveness transitions to skill_stats.
   * Applies boost/decay/neutral per effect, bumps counters, records co-occurrence.
   * No-op when dbPath is null (incognito / no memory configured).
   */
  flush(
    _sessionId: string,
    good: boolean,
    effects: SkillEffect[],
    cooc: Array<[string, string]>,
  ): void {
    if (!this.dbPath || effects.length === 0) return;
    try {
      const db = openDatabase(this.dbPath);
      try {
        ensureSkillStatsTable(db);
        const now = Date.now();
        for (const effect of effects) {
          const { skillId, scope, used } = effect;
          // Boost/decay logic mirrors memory's flushReinforcements.
          const mode = used && good ? "boost" : used && !good ? "neutral" : "decay";
          // INSERT ensures the row exists before updateSkillUsefulness can UPDATE it.
          bumpSkillStats(db, scope, skillId, 1, used ? 1 : 0, now);
          updateSkillUsefulness(db, scope, skillId, mode);
        }
        if (cooc.length > 0) {
          // All co-occurrence pairs from a session are stored under the project scope.
          bumpSkillCooccurrence(db, this.projectScope, cooc);
        }
      } finally {
        db.close();
      }
    } catch (err) {
      // Stats-flush bug must never block shutdown — log and continue.
      getAppLogger().child("skills").warn("Skill stats flush failed", { cause: err as Error });
    }
  }
}
