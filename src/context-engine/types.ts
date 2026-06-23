// ============================================================
// PRAANA Context Engine — Types
// ============================================================

export type ContentType =
  | "code"
  | "diff"
  | "log"
  | "json"
  | "test_output"
  | "build_output"
  | "search_results"
  | "error"
  | "prose"
  | "other";

export interface ContextArtifact {
  id: string;
  sha256: string;
  sessionId: string;
  sourceTool: string;
  command?: string;
  createdTurn: number;
  rawTokens: number;
  rawText: string;
  summary: string;
  contentType: ContentType;
  lastAccessedTurn: number;
  accessCount: number;
}

export interface IngestToolResultInput {
  sourceTool: string;
  command?: string;
  rawText: string;
  contentType?: ContentType;
  createdTurn: number;
}

export interface IngestToolResultOutput {
  /** Text placed in LLM conversation history */
  promptText: string;
  artifactId?: string;
  inlined: boolean;
}

export interface RetrieveArtifactOptions {
  grep?: string;
  lineStart?: number;
  lineEnd?: number;
  jsonPath?: string;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  resultArtifactId?: string;
  isError: boolean;
  /** Truncated tool result text for deterministic activity rules (full text in artifact store) */
  resultText?: string;
}

export interface TurnDigestDecision {
  summary: string;
  rationale?: string;
}

export interface TurnDigest {
  turnId: number;
  userIntent: string;
  filesChanged: string[];
  filesWritten: string[];
  artifactRefs: string[];
  decisions: TurnDigestDecision[];
  constraints: string[];
  errorsNew: string[];
  errorsFixed: string[];
  toolSummary: string;
  /** Plan text extracted from the assistant message, if any */
  extractedPlan?: string;
}

export type ActivityEntryType =
  | "commit"
  | "test_pass"
  | "test_fail"
  | "error_fixed"
  | "file_written"
  | "decision_made";

export interface ActivityEntry {
  turn: number;
  type: ActivityEntryType;
  summary: string;
  artifactRef?: string;
}

export interface StateSnapshot {
  objects: Map<string, { kind: string; updated: number; payloadJson: string }>;
}

export interface OpenError {
  key: string;
  message: string;
  turn: number;
  tool: string;
  command?: string;
}

export interface CheckpointDraft {
  lastUserIntent: string;
  openErrors: OpenError[];
  recentDecisions: Array<{ summary: string; turn: number }>;
  recentConstraints: string[];
  recentActivity: ActivityEntry[];
}

/** When compact is true, summary renders as a one-liner; rationale is always retained. */
export interface CheckpointDecisionEntry {
  summary: string;
  rationale?: string;
  turn: number;
  compact?: boolean;
}

export interface CheckpointNarrativeEntry {
  turn: number;
  text: string;
}

export interface CheckpointPlanEntry {
  text: string;
  turn: number;
  superseded: boolean;
  supersededTurn?: number;
  completed?: string[];
}

export interface CheckpointFileEntry {
  path: string;
  turn: number;
}

export interface CheckpointErrorEntry {
  key: string;
  message: string;
  turn: number;
  fixed: boolean;
  fixedTurn?: number;
}

export interface CheckpointFindingEntry {
  summary: string;
  artifactRef?: string;
  turn: number;
}

export interface CheckpointQuestionEntry {
  text: string;
  turn: number;
  closed: boolean;
}

export interface CheckpointState {
  activeRequest: string;
  plans: CheckpointPlanEntry[];
  constraints: string[];
  decisions: CheckpointDecisionEntry[];
  files: CheckpointFileEntry[];
  findings: CheckpointFindingEntry[];
  errors: CheckpointErrorEntry[];
  questions: CheckpointQuestionEntry[];
  activity: ActivityEntry[];
  narrative: CheckpointNarrativeEntry[];
  lastReconciledTurn: number;
}

export interface SessionCheckpoint {
  version: 1;
  state: CheckpointState;
}

export type ContextUnitType =
  | "verbatim_turn"
  | "turn_digest"
  | "checkpoint_section"
  | "artifact_card"
  | "activity_entry"
  | "memory_digest"
  | "active_state";

export interface ContextUnit {
  id: string;
  type: ContextUnitType;
  content: string;
  tokens: number;
  sourceTurn: number;
  score: number;
  pinned: boolean;
  artifactRefs: string[];
}

export interface ScoreBreakdown {
  pin: number;
  recency: number;
  relevance: number;
  /** Boost from auto-hydrated object text overlap; 0 when feature is off. */
  hydrate_boost: number;
}

export interface ScoredContextUnit extends ContextUnit {
  breakdown: ScoreBreakdown;
}

export type PressureMode = "normal" | "compact" | "emergency";

export interface CompileScoreRecord {
  turn: number;
  unitId: string;
  type: ContextUnitType;
  score: number;
  included: boolean;
  band: number;
  tokens: number;
  breakdown: ScoreBreakdown;
}

export interface TurnRecord {
  turn: number;
  userMessage: string;
  assistantMessage: string;
  toolCalls: ToolCallRecord[];
  artifactIds: string[];
  filesRead: string[];
  filesWritten: string[];
  errors: string[];
  tokenCount: number;
  timestamp: number;
}

export interface TurnSearchMatch {
  turn: number;
  score: number;
  userMessage: string;
  assistantMessage: string;
  excerpt: string;
  artifactIds: string[];
  filesRead: string[];
  filesWritten: string[];
  errors: string[];
  timestamp: number;
}
