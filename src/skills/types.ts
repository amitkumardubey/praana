/**
 * Skill types for the pull-model loading system (issue #96).
 *
 * No BM25, no residency tiers (hot/warm/cold), no progressive section
 * hydration. The catalog is a tiny list of skill names + descriptions.
 * The LLM loads full SKILL.md bodies on-demand via the load_skill tool.
 * Engine mode tracks loads, evicts by recency+budget, and emits telemetry.
 * Classic mode is a plain agent: load_skill reads the body, no tracking.
 */

// ---- Parsed SKILL.md ----

export interface SkillMetadata {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
}

export interface SkillRecord {
  name: string;
  description: string;
  location: string;
  directory: string;
  body: string;
  metadata: SkillMetadata;
}

// ---- Runtime types ----

export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  location: string;
}

/** Currently-loaded skill tracked by SkillRuntime in engine mode. */
export interface LoadedSkill {
  skillId: string;
  loadedTurn: number;
  reloadCount: number;
}

// ---- Config ----

export interface SkillsRuntimeConfig {
  enabled: boolean;
  max_token_budget_ratio: number;
  max_loaded_skills: number;
  stale_threshold_turns: number;
  max_depth: number;
  /** Override search paths for discovery (testing only). */
  searchPaths?: string[];
}

// ---- Telemetry ----

export interface SkillTelemetryEvent {
  type: "skill_loaded" | "skill_reloaded" | "skill_evicted";
  skill_id: string;
  loaded_turn: number;
  reload_count?: number;
  timestamp: number;
}
