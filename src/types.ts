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
  | "ui_transcript"
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
  /** Optional provider/model to use when the primary fails (timeout, 429, empty). */
  fallback_provider?: string;
  fallback_model?: string;
  /**
   * Default reasoning effort for reasoning-capable models.
   * One of: off | minimal | low | medium | high | xhigh (or none → off).
   * Session `/reasoning` overrides this; see issue #38.
   */
  reasoning_effort?: string;
  /** AWS region for amazon-bedrock catalog + invoke. Ignored by other providers. */
  region?: string;
}

// ---- User-Declared Providers (declarative config) ----

/**
 * Optional model metadata override for a user-declared provider.
 * The model LIST (what models exist on the server) is fetched live
 * and cached by provider-catalog.ts; this is only for per-model
 * metadata that the /v1/models endpoint doesn't provide.
 */
export interface UserProviderModel {
  id: string;
  context_window?: number;
  reasoning?: boolean;
  max_tokens?: number;
  /** pi-ai API id override (e.g. "openai-completions"). Rarely needed. */
  api?: string;
}

/**
 * A user-declared provider in config.toml under `[providers.<id>]`.
 *
 * This lets users connect ANY OpenAI-compatible (or other API) provider
 * without it being in PRAANA's hardcoded PROVIDER_REGISTRY. The provider
 * id is the key (e.g. "my-llama"), and the config section defines how to
 * reach it.
 *
 * Example:
 *   [providers.my-llama]
 *   api = "openai-completions"
 *   base_url = "http://localhost:8080/v1"
 *   env_key = "MY_LLAMA_KEY"   # optional
 *
 *   [[providers.my-llama.models]]
 *   id = "llama-3.1-8b"
 *   context_window = 128000
 */
export interface UserProviderConfig {
  /** pi-ai API type identifier (e.g. "openai-completions", "anthropic-messages"). */
  api: string;
  /** Base URL for the provider's API (e.g. "http://localhost:8080/v1"). */
  base_url: string;
  /** Env var to check for API key as fallback to credential store. Omit for keyless. */
  env_key?: string;
  /** Optional HTTP headers sent with every request. */
  headers?: Record<string, string>;
  /** Optional per-model metadata overrides. */
  models?: UserProviderModel[];
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
  /** Max share of usable prompt budget for Cognitive Memory section. */
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
  /**
   * Turns of inactivity before an active task is considered stale on resume.
   * Default: 5.
   */
  stale_task_turn_threshold?: number;
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
  max_loaded_skills: number;
  stale_threshold_turns: number;
  max_depth: number;
}

export interface EditConfig {
  confirm: boolean;
}

export interface RiskConfig {
  /** Headless-only class ids permitted without a prompt. Default: []. */
  allow: readonly string[];
}

export interface ToolsConfig {
  /** When true, second+ read_file of the same abs path hard-fails. Default: false (warn and return artifact card). */
  block_repeat_reads: boolean;
}

export interface SearchCodeConfig {
  /** Absolute path to the ripgrep binary. Omit to use system "rg" via PATH. */
  rg_path?: string;
}

/** Native capability layer (@praana/natives) — issue #313 / #11. */
export interface NativeConfig {
  /** When false, never load the addon; code_* tools return unavailable. Default: true. */
  enabled: boolean;
  /**
   * Reserved for hard-fail at session start when addon missing.
   * Phase 1 always soft-fails in tools regardless of this flag.
   */
  require: boolean;
}

/** LSP client layer (issue #11 Phase 2) — external language servers via stdio. */
export interface LspConfig {
  /** When false, never spawn servers; lsp_* tools return disabled. Default: false. */
  enabled: boolean;
  /** Collect / attach diagnostics on tools and post-edit. Default: true. */
  diagnostics: boolean;
  /** After successful edit_file/batch_edit, request LSP formatting. Default: false. */
  format_on_edit: boolean;
  /** Per-request timeout in milliseconds. Default: 5000. */
  timeout_ms: number;
  /** Skip diagnostics/format when file exceeds this many lines. Default: 10000. */
  max_file_lines: number;
  /** Language id → argv (executable + args). Empty = no server for that language. */
  servers: Record<string, string[]>;
}

/** Post-edit verification (issue #299) — syntax / scoped tsc / test-impact. */
export interface VerifyConfig {
  /** When false, skip the verify hook. Default: false. */
  enabled: boolean;
  /** Tree-sitter parse after successful writes. Default: true. */
  syntax: boolean;
  /** Scoped tsc --noEmit after successful writes. Default: true. */
  typecheck: boolean;
  /** Reverse-import test-impact after clean syntax+tsc. Default: true. */
  tests: boolean;
  /** Per typecheck/test spawn timeout in milliseconds. Default: 30000. */
  timeout_ms: number;
  /** Run at most this many affected test files. Default: 20. */
  max_test_files: number;
}

export interface UiConfig {
  markdown_rendering: boolean;
  syntax_highlighting: boolean;
  syntax_theme: string;
  /** How recall/memory signals surface in the transcript. */
  ambient: "inline" | "quiet";
  /** Glyph set for tool rows. */
  tool_icons: "unicode" | "ascii";
  /** Elevation zones (OSC11 bg detection → per-role bg tinting). */
  background_zones: boolean;
  /** Show cumulative session token counts in the glance bar. */
  show_cost: boolean;
  /** Show the figlet boot banner. */
  banner: boolean;
}

export type DistillerIntensity = "lite" | "full";

export interface ContextEngineDistillerConfig {
  default_intensity: DistillerIntensity;
}

export interface ContextEngineScoringConfig {
  w_pin: number;
  w_recency: number;
  w_relevance: number;
  /** Weight for embedding-based semantic similarity relevance. */
  w_semantic?: number;
  /** Boost for context units whose content overlaps with auto-hydrated object text. */
  w_hydrate_boost?: number;
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

export interface CircuitConfig {
  /** Allow this many identical mutating calls / errors before blocking. */
  loop_threshold: number;
  /** Headless-only; 0 = off. Input+output tokens accumulated this run. */
  max_tokens: number;
  /** Headless-only; 0 = off. Wall clock from session start. */
  max_wall_ms: number;
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
  /** Optional; defaults to { allow: [] } when omitted. */
  risk?: RiskConfig;
  /** Optional; defaults to { block_repeat_reads: false } when omitted. */
  tools?: ToolsConfig;
  search_code?: SearchCodeConfig;
  /** Optional; defaults to { enabled: true, require: false } when omitted. */
  native?: NativeConfig;
  /** Optional; defaults to disabled LSP client when omitted. */
  lsp?: LspConfig;
  /** Optional; defaults to disabled post-edit verification when omitted. */
  verify?: VerifyConfig;
  skills: SkillsConfig;
  ui: UiConfig;
  context_engine: ContextEngineConfig;
  project_detection: ProjectDetectionConfig;
  turn: TurnConfig;
  /** Optional; defaults to threshold 3 and no headless token/time caps. */
  circuit?: CircuitConfig;
  /**
   * User-declared providers, keyed by provider id. Each entry defines an
   * OpenAI-compatible (or other API) endpoint that is NOT in PRAANA's
   * hardcoded PROVIDER_REGISTRY. Declared in config.toml under
   * `[providers.<id>]`. Keys in the credential store take precedence
   * over env_key for authentication.
   */
  providers?: Record<string, UserProviderConfig>;
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
