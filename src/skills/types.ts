// ---- Residency ----

export type SkillResidency = "hot" | "warm" | "cold";

export type SkillSection = "planner" | "execution" | "recovery" | "examples";

export const ALL_SKILL_SECTIONS: SkillSection[] = ["planner", "execution", "recovery", "examples"];

export const SECTION_HEADINGS: Record<SkillSection, string> = {
  planner: "## Planner",
  execution: "## Execution",
  recovery: "## Recovery",
  examples: "## Examples",
};

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

// ---- Metadata extensions (from <scope>/.praana/skills-meta.json) ----

export interface SkillSectionMapping {
  planner?: string[];
  execution?: string[];
  recovery?: string[];
  examples?: string[];
}

export interface SkillBudgetConfig {
  priority?: "normal" | "high" | "low";
  max_tokens?: number;
}

export interface SkillMetaExtensions {
  tags?: string[];
  trigger?: string;
  synonyms?: string[];
  neighbors?: string[];
  sections?: SkillSectionMapping;
  budget?: SkillBudgetConfig;
}

export type SkillsMetaFile = Record<string, SkillMetaExtensions>;

// ---- Runtime types ----

export interface SkillIndexEntry {
  id: string;
  name: string;
  description: string;
  tags: string[];
  trigger?: string;
  synonyms?: string[];
  neighbors?: string[];
  /** Tokenized searchable text for BM25 */
  searchText: string;
  /** Parsed section boundaries from SKILL.md body */
  sectionRanges?: Record<SkillSection, { start: number; end: number }>;
  budgetPriority: "normal" | "high" | "low";
  maxTokens: number;
}

export interface SkillRuntimeState {
  entry: SkillIndexEntry;
  residency: SkillResidency;
  loadedSections: SkillSection[];
  lastActiveTurn: number;
  tokenCost: number;
  /** Full body text cached from discovery */
  body: string;
  /** Directory path for resolving relative references */
  directory: string;
}

export interface SkillRuntimeSnapshot {
  hot: SkillRuntimeState[];
  warm: SkillRuntimeState[];
  tokenUsage: number;
  tokenBudget: number;
}

// ---- Config ----

export interface SkillsRuntimeConfig {
  enabled: boolean;
  max_token_budget_ratio: number;
  active_skill_idle_turns: number;
  warm_skill_eviction_turns: number;
  max_depth: number;
  /** Override search paths for discovery (testing only). */
  searchPaths?: string[];
}

// ---- Telemetry ----

export interface SkillTelemetryEvent {
  type:
    | "skill_discovered"
    | "skill_matched"
    | "skill_loaded"
    | "skill_promoted"
    | "skill_demoted"
    | "skill_evicted"
    | "skill_hydrated"
    | "skill_budget_exceeded"
    | "skill_neighbor_boosted";
  skill_id: string;
  residency?: SkillResidency;
  sections?: string[];
  token_cost?: number;
  score?: number;
  prev_residency?: SkillResidency;
  timestamp: number;
}
