// ============================================================
// PRAANA — Core Types
// ============================================================

// ---- State Objects ----

export type StateObjectKind = "task" | "decision" | "constraint" | "note";
export type StateTier = "active" | "soft" | "hard";

export interface TaskPayload {
  title: string;
  description?: string;
  status: "todo" | "doing" | "done";
}

export interface DecisionPayload {
  summary: string;
  rationale: string;
}

export interface ConstraintPayload {
  text: string;
}

export interface NotePayload {
  text: string;
}

export type StatePayload =
  | TaskPayload
  | DecisionPayload
  | ConstraintPayload
  | NotePayload;

export interface StateObject {
  id: string; // ULID
  kind: StateObjectKind;
  tier: StateTier;
  payload: StatePayload;
  created: number; // unix ms
  updated: number; // unix ms
  lastTouched: number; // unix ms, for idle-timer tier management
  focused?: boolean;
  retracted?: boolean;
}

// ---- Event Log ----

export type EventKind =
  | "user_message"
  | "agent_message"
  | "tool_call"
  | "tool_result"
  | "context_action"
  | "system_note";

export type EventActor = "user" | "agent" | "kernel" | "tool";

export interface Event {
  event_id: string; // ULID, monotonic within session
  session_id: string;
  timestamp: number; // unix ms
  kind: EventKind;
  actor: EventActor;
  payload: Record<string, unknown>;
}

// ---- Tool result types ----

export interface ToolResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface CreateTaskResult extends ToolResult {
  id?: string;
}

export interface ListStateResult extends ToolResult {
  objects?: Array<{
    id: string;
    kind: StateObjectKind;
    tier: StateTier;
    summary: string;
  }>;
}

export interface HydrateResult extends ToolResult {
  payload?: Record<string, unknown>;
}

export interface RecallResult extends ToolResult {
  entries?: Array<{
    id: string;
    kind: string;
    content: string;
    score?: number;
    validity?: number;
    usefulness?: number;
    scopes?: string[];
  }>;
}

export interface RememberResult extends ToolResult {
  id?: string;
}

// ---- Config ----

export interface LlmConfig {
  provider: string;
  model: string;
  base_url?: string;
  /** Override model context window (input tokens) for pressure and compaction. */
  context_window?: number;
}

export type EmbedderStrategy =
  | "auto"
  | "ollama"
  | "transformers"
  | "transformers-nomic";

export interface MemoryConfig {
  enabled: boolean;
  /** disabled | ollama | openrouter | openai */
  summarizer: string;
  db_path?: string;
  embedder?: EmbedderStrategy;
  /** Hugging Face model id, e.g. Xenova/all-MiniLM-L6-v2 */
  transformers_model?: string;
  ollama_url?: string;
  /** Embedding model (e.g. nomic-embed-text) */
  ollama_model?: string;
  /** Chat model for session-end learnings (e.g. qwen3.5:4b). Falls back to first non-embed model from `ollama list`. */
  ollama_summarizer_model?: string;
}

export interface CompilerConfig {
  token_budget: number;
  recent_turns: number;
  recent_turns_token_budget?: number;
  /** Minimum digest score for a memory entry to appear in the prompt. */
  recall_min_score?: number;
  /** Max share of usable prompt budget for cross-session memory section. */
  memories_budget_ratio?: number;
  /** Max share of usable prompt budget for project context (AGENTS.md). */
  agents_budget_ratio?: number;

  /** Tokens reserved for model output when computing section ceilings. */
  reserved_output_tokens?: number;
  /** Context fill ratio (0–1) that triggers auto-compaction. Default: 0.75. */
  auto_compact_at?: number;
  /** Disarm compaction hysteresis below this ratio. Default: 0.55. */
  auto_compact_clear_at?: number;
  /** Fraction (0–1) of oldest transcript events to compact per trigger. Default: 0.25. */
  compact_chunk_fraction?: number;
  /** Classic mode: never auto-compact (full verbatim until model limit). Default: false. */
  verbatim_only?: boolean;
  /** @deprecated Use auto_compact_at */
  compression_watermark?: number;
  /** @deprecated Use compact_chunk_fraction */
  compression_flush_fraction?: number;
}

export interface TiersConfig {
  idle_soft_after_turns: number;
  idle_hard_after_turns: number;
}

export interface SessionConfig {
  log_dir: string;
  /**
   * Max ms to wait for the session-end summarizer LLM call before backgrounding it.
   * Used by `AppController.shutdown()`. Default: 2000.
   */
  shutdown_memory_timeout_ms?: number;
}

export interface ConsolidationConfig {
  /** Enable/disable the background consolidation processor. */
  enabled: boolean;
  /** LLM model for consolidation (defaults to memory.summarizer). */
  model?: string;
  /** Number of confirmations needed to promote to Layer 2. Default: 3. */
  promotion_threshold: number;
  /** Delay in seconds after session end before running consolidation. Default: 30. */
  run_delay_seconds: number;
}

export interface SandboxConfig {
  enabled: boolean;
  readonly allowed_paths: readonly string[];
}

// ---- Skills ----

export type { SkillMetadata, SkillRecord } from "./skills/types.js";

export interface SkillsConfig {
  enabled: boolean;
  max_token_budget_ratio: number;
  active_skill_idle_turns: number;
  warm_skill_eviction_turns: number;
  max_depth: number;
}

export interface EditConfig {
  confirm: boolean;
}

export interface SearchCodeConfig {
  /** Absolute path to the ripgrep binary. Omit to use system "rg" via PATH. */
  rg_path?: string;
}

export type UiMode = "readline" | "tui";
export type UiScreenMode = "preserve" | "alternate";

export interface UiConfig {
  mode: UiMode;
  screen: UiScreenMode;
  markdown_rendering: boolean;
  syntax_highlighting: boolean;
  syntax_theme: string;
}

export type DistillerIntensity = "lite" | "full";

export interface ContextEngineDistillerConfig {
  default_intensity: DistillerIntensity;
}

export interface ContextEngineScoringConfig {
  w_pin: number;
  w_recency: number;
  w_relevance: number;
}

export interface ContextEnginePressureConfig {
  compact_at: number;
  emergency_at: number;
}

export interface ContextEngineConfig {
  /** false = classic mode (full verbatim history, no StateGraph, skill metadata only). */
  enabled: boolean;
  /** Write context-engine telemetry when engine is off (debug / comparison). */
  measurement_mode: boolean;
  /** Tool outputs at or below this token count appear verbatim in the prompt. */
  artifact_inline_threshold: number;
  /** Turns without access before an artifact is eligible for eviction. */
  artifact_ttl_turns: number;
  distiller: ContextEngineDistillerConfig;
  /** Use LLM for ambiguous userIntent extraction (default: first 120 chars). */
  llm_digest: boolean;
  /** Max rolling activity entries kept for checkpoint preview. */
  activity_log_max_entries: number;
  /** Enable structured SessionCheckpoint in the prompt. */
  checkpoint_enabled: boolean;
  scoring: ContextEngineScoringConfig;
  pressure: ContextEnginePressureConfig;
}

export interface ProjectDetectionConfig {
  enabled: boolean;
  /** Override auto-detected languages (e.g. ["TypeScript", "Python"]) */
  manual_languages?: string[];
  /** Override auto-detected frameworks (e.g. ["React", "FastAPI"]) */
  manual_frameworks?: string[];
}

export interface TurnConfig {
  /** Max LLM rounds per user message (each round may batch multiple tool calls). */
  max_steps: number;
}

export interface PraanaConfig {
  llm: LlmConfig;
  memory: MemoryConfig;
  compiler: CompilerConfig;
  tiers: TiersConfig;
  session: SessionConfig;
  consolidation: ConsolidationConfig;
  shell: SandboxConfig;
  edit: EditConfig;
  search_code?: SearchCodeConfig;
  skills: SkillsConfig;
  ui: UiConfig;
  context_engine: ContextEngineConfig;
  project_detection: ProjectDetectionConfig;
  turn: TurnConfig;
}
// ---- Session Meta ----

export interface SessionMeta {
  session_id: string;
  started_at: number;
  cwd: string;
  agent: string;
}

// ---- Compiler ----

export interface CompilerOptions {
  stateGraph: any; // StateGraph instance (circular dep, typed loosely)
  memoryDigest: string | null;
  recentEvents: Event[];
  userInput: string;
  toolSchemas: string[];
  cwd: string;
  sessionId: string;
  tokenBudget: number;
}
