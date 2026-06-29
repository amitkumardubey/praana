import Database from "better-sqlite3";
import type {
  ActivityEntry,
  ContextArtifact,
  ContentType,
  OpenError,
  SessionCheckpoint,
  TurnDigest,
  TurnRecord,
} from "./types.js";

const ARTIFACT_SCHEMA = `
CREATE TABLE IF NOT EXISTS context_artifacts (
  id                  TEXT PRIMARY KEY,
  sha256              TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  source_tool         TEXT NOT NULL,
  command             TEXT,
  created_turn        INTEGER NOT NULL,
  raw_tokens          INTEGER NOT NULL,
  raw_text            TEXT NOT NULL,
  summary             TEXT NOT NULL,
  content_type        TEXT NOT NULL,
  last_accessed_turn  INTEGER NOT NULL,
  access_count        INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_context_artifacts_session
  ON context_artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_context_artifacts_sha256
  ON context_artifacts(sha256);

CREATE TABLE IF NOT EXISTS distiller_stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,
  tool          TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  distiller     TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  savings_pct   REAL NOT NULL,
  exec_time_ms  INTEGER NOT NULL,
  turn          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_distiller_stats_session
  ON distiller_stats(session_id);

CREATE TABLE IF NOT EXISTS turn_ledger (
  session_id          TEXT NOT NULL,
  turn                INTEGER NOT NULL,
  user_message        TEXT NOT NULL,
  assistant_message   TEXT NOT NULL,
  tool_calls_json     TEXT NOT NULL,
  artifact_ids_json   TEXT NOT NULL,
  files_read_json     TEXT NOT NULL,
  files_written_json  TEXT NOT NULL,
  errors_json         TEXT NOT NULL,
  token_count         INTEGER NOT NULL,
  search_text         TEXT NOT NULL,
  timestamp           INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
);

CREATE INDEX IF NOT EXISTS idx_turn_ledger_session
  ON turn_ledger(session_id);

CREATE TABLE IF NOT EXISTS turn_digests (
  session_id   TEXT NOT NULL,
  turn         INTEGER NOT NULL,
  digest_json  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  turn         INTEGER NOT NULL,
  type         TEXT NOT NULL,
  summary      TEXT NOT NULL,
  artifact_ref TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_log_session
  ON activity_log(session_id, id DESC);

CREATE TABLE IF NOT EXISTS extraction_state (
  session_id   TEXT PRIMARY KEY,
  state_json   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_checkpoints (
  session_id       TEXT PRIMARY KEY,
  checkpoint_json  TEXT NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_access (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id   TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  access_type   TEXT NOT NULL,
  turn          INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifact_access_session
  ON artifact_access(session_id, artifact_id);

CREATE TABLE IF NOT EXISTS session_stats (
  session_id              TEXT PRIMARY KEY,
  context_engine_enabled  INTEGER NOT NULL DEFAULT 0,
  pressure_events         INTEGER NOT NULL DEFAULT 0,
  compaction_triggers     INTEGER NOT NULL DEFAULT 0,
  artifact_retrievals     INTEGER NOT NULL DEFAULT 0,
  total_distiller_savings REAL NOT NULL DEFAULT 0,
  total_turns             INTEGER NOT NULL DEFAULT 0,
  updated_at              INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scorecard (
  session_id           TEXT PRIMARY KEY,
  context_engine_on    INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,

  -- context engine
  artifact_retrieve_calls   INTEGER DEFAULT 0,
  artifact_cards_produced   INTEGER DEFAULT 0,
  repeat_file_reads         INTEGER DEFAULT 0,
  decision_contradictions   INTEGER DEFAULT 0,
  turn_event_searches       INTEGER DEFAULT 0,
  total_turns               INTEGER DEFAULT 0,
  pressure_events           INTEGER DEFAULT 0,
  compaction_triggers       INTEGER DEFAULT 0,

  -- memory
  recall_calls              INTEGER DEFAULT 0,
  recall_used_count         INTEGER DEFAULT 0,
  validity_avg_start        REAL    DEFAULT 0,
  validity_avg_end          REAL    DEFAULT 0,
  usefulness_avg_start      REAL    DEFAULT 0,
  usefulness_avg_end        REAL    DEFAULT 0,

  -- skills
  skills_loaded             INTEGER DEFAULT 0,
  skills_used               INTEGER DEFAULT 0,
  skill_underload_events    INTEGER DEFAULT 0,
  skill_reload_count        INTEGER DEFAULT 0,
  skill_tokens_consumed     INTEGER DEFAULT 0,
  skill_load_events         INTEGER DEFAULT 0,

  -- resume state (digests / catalog ids — no file paths)
  read_path_digests         TEXT NOT NULL DEFAULT '',
  skills_ever_loaded        TEXT NOT NULL DEFAULT ''
);
`;

const SCORECARD_RESUME_COLUMNS: Array<{ name: string; ddl: string }> = [
  { name: "skill_load_events", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { name: "read_path_digests", ddl: "TEXT NOT NULL DEFAULT ''" },
  { name: "skills_ever_loaded", ddl: "TEXT NOT NULL DEFAULT ''" },
];

function ensureScorecardResumeColumns(db: Database.Database): void {
  const existing = new Set(
    (db.prepare("PRAGMA table_info(scorecard)").all() as Array<{ name: string }>).map(
      (col) => col.name,
    ),
  );
  for (const col of SCORECARD_RESUME_COLUMNS) {
    if (!existing.has(col.name)) {
      db.exec(`ALTER TABLE scorecard ADD COLUMN ${col.name} ${col.ddl}`);
    }
  }
}

export interface DistillerStatRow {
  sessionId: string;
  tool: string;
  contentType: string;
  distiller: string;
  inputTokens: number;
  outputTokens: number;
  savingsPct: number;
  execTimeMs: number;
  turn: number;
}

export function openContextEngineDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(ARTIFACT_SCHEMA);
  ensureScorecardResumeColumns(db);
  return db;
}

interface ArtifactRow {
  id: string;
  sha256: string;
  session_id: string;
  source_tool: string;
  command: string | null;
  created_turn: number;
  raw_tokens: number;
  raw_text: string;
  summary: string;
  content_type: string;
  last_accessed_turn: number;
  access_count: number;
}

function rowToArtifact(row: ArtifactRow): ContextArtifact {
  return {
    id: row.id,
    sha256: row.sha256,
    sessionId: row.session_id,
    sourceTool: row.source_tool,
    command: row.command ?? undefined,
    createdTurn: row.created_turn,
    rawTokens: row.raw_tokens,
    rawText: row.raw_text,
    summary: row.summary,
    contentType: row.content_type as ContentType,
    lastAccessedTurn: row.last_accessed_turn,
    accessCount: row.access_count,
  };
}

export function findArtifactByHash(
  db: Database.Database,
  sha256: string,
): ContextArtifact | null {
  const row = db
    .prepare("SELECT * FROM context_artifacts WHERE sha256 = ? LIMIT 1")
    .get(sha256) as ArtifactRow | undefined;
  return row ? rowToArtifact(row) : null;
}

export function getArtifactById(
  db: Database.Database,
  id: string,
): ContextArtifact | null {
  const row = db
    .prepare("SELECT * FROM context_artifacts WHERE id = ?")
    .get(id) as ArtifactRow | undefined;
  return row ? rowToArtifact(row) : null;
}

export function insertArtifact(
  db: Database.Database,
  artifact: ContextArtifact,
): void {
  db.prepare(
    `INSERT INTO context_artifacts (
      id, sha256, session_id, source_tool, command, created_turn,
      raw_tokens, raw_text, summary, content_type,
      last_accessed_turn, access_count, created_at
    ) VALUES (
      @id, @sha256, @sessionId, @sourceTool, @command, @createdTurn,
      @rawTokens, @rawText, @summary, @contentType,
      @lastAccessedTurn, @accessCount, @createdAt
    )`,
  ).run({
    id: artifact.id,
    sha256: artifact.sha256,
    sessionId: artifact.sessionId,
    sourceTool: artifact.sourceTool,
    command: artifact.command ?? null,
    createdTurn: artifact.createdTurn,
    rawTokens: artifact.rawTokens,
    rawText: artifact.rawText,
    summary: artifact.summary,
    contentType: artifact.contentType,
    lastAccessedTurn: artifact.lastAccessedTurn,
    accessCount: artifact.accessCount,
    createdAt: Date.now(),
  });
}

export function touchArtifactAccess(
  db: Database.Database,
  id: string,
  turn: number,
): void {
  db.prepare(
    `UPDATE context_artifacts
     SET last_accessed_turn = @turn, access_count = access_count + 1
     WHERE id = @id`,
  ).run({ id, turn });
}

export function updateArtifactSummary(
  db: Database.Database,
  id: string,
  summary: string,
): void {
  db.prepare("UPDATE context_artifacts SET summary = @summary WHERE id = @id").run({
    id,
    summary,
  });
}

export function insertDistillerStat(
  db: Database.Database,
  row: DistillerStatRow,
): void {
  db.prepare(
    `INSERT INTO distiller_stats (
      session_id, tool, content_type, distiller,
      input_tokens, output_tokens, savings_pct, exec_time_ms, turn, created_at
    ) VALUES (
      @sessionId, @tool, @contentType, @distiller,
      @inputTokens, @outputTokens, @savingsPct, @execTimeMs, @turn, @createdAt
    )`,
  ).run({
    sessionId: row.sessionId,
    tool: row.tool,
    contentType: row.contentType,
    distiller: row.distiller,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    savingsPct: row.savingsPct,
    execTimeMs: row.execTimeMs,
    turn: row.turn,
    createdAt: Date.now(),
  });
}

export function evictStaleArtifacts(
  db: Database.Database,
  currentTurn: number,
  ttlTurns: number,
): number {
  const cutoff = currentTurn - ttlTurns;
  const extendedCutoff = currentTurn - ttlTurns * 2;
  const result = db
    .prepare(
      `DELETE FROM context_artifacts
       WHERE (access_count < 4 AND last_accessed_turn < @cutoff)
          OR (access_count >= 4 AND last_accessed_turn < @extendedCutoff)`,
    )
    .run({ cutoff, extendedCutoff });
  return result.changes;
}

/**
 * M4 artifact promotion: list artifacts worth promoting to Cognitive Memory.
 * Trigger: accessed at least `minAccessCount` times in this session. Articles
 * accessed multiple times are the ones an agent had to recall to do its job —
 * the ones the spec ("decisions/003 Finding #14") calls out as high-value.
 *
 * Returns rows ordered by access_count DESC so dedup can prefer the hottest one
 * if multiple promoted artifacts collide.
 */
export function listHighValueArtifacts(
  db: Database.Database,
  sessionId: string,
  minAccessCount: number,
): ContextArtifact[] {
  if (minAccessCount < 1) {
    throw new Error(
      `listHighValueArtifacts: minAccessCount must be >= 1, got ${minAccessCount}`,
    );
  }
  const rows = db
    .prepare(
      `SELECT * FROM context_artifacts
       WHERE session_id = ?
         AND access_count >= ?
       ORDER BY access_count DESC, created_at DESC`,
    )
    .all(sessionId, minAccessCount) as ArtifactRow[];
  return rows.map((r) => rowToArtifact(r));
}

interface TurnLedgerRow {
  session_id: string;
  turn: number;
  user_message: string;
  assistant_message: string;
  tool_calls_json: string;
  artifact_ids_json: string;
  files_read_json: string;
  files_written_json: string;
  errors_json: string;
  token_count: number;
  search_text: string;
  timestamp: number;
}

function rowToTurnRecord(row: TurnLedgerRow): TurnRecord {
  return {
    turn: row.turn,
    userMessage: row.user_message,
    assistantMessage: row.assistant_message,
    toolCalls: JSON.parse(row.tool_calls_json),
    artifactIds: JSON.parse(row.artifact_ids_json),
    filesRead: JSON.parse(row.files_read_json),
    filesWritten: JSON.parse(row.files_written_json),
    errors: JSON.parse(row.errors_json),
    tokenCount: row.token_count,
    timestamp: row.timestamp,
  };
}

export function getMaxLedgerTurn(
  db: Database.Database,
  sessionId: string,
): number | null {
  const row = db
    .prepare("SELECT MAX(turn) AS max_turn FROM turn_ledger WHERE session_id = ?")
    .get(sessionId) as { max_turn: number | null } | undefined;
  return row?.max_turn ?? null;
}

export function hasLedgerTurn(
  db: Database.Database,
  sessionId: string,
  turn: number,
): boolean {
  const row = db
    .prepare("SELECT 1 FROM turn_ledger WHERE session_id = ? AND turn = ? LIMIT 1")
    .get(sessionId, turn);
  return !!row;
}

export function insertTurnRecord(
  db: Database.Database,
  sessionId: string,
  record: TurnRecord,
  searchText: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO turn_ledger (
      session_id, turn, user_message, assistant_message,
      tool_calls_json, artifact_ids_json, files_read_json, files_written_json,
      errors_json, token_count, search_text, timestamp
    ) VALUES (
      @sessionId, @turn, @userMessage, @assistantMessage,
      @toolCallsJson, @artifactIdsJson, @filesReadJson, @filesWrittenJson,
      @errorsJson, @tokenCount, @searchText, @timestamp
    )`,
  ).run({
    sessionId,
    turn: record.turn,
    userMessage: record.userMessage,
    assistantMessage: record.assistantMessage,
    toolCallsJson: JSON.stringify(record.toolCalls),
    artifactIdsJson: JSON.stringify(record.artifactIds),
    filesReadJson: JSON.stringify(record.filesRead),
    filesWrittenJson: JSON.stringify(record.filesWritten),
    errorsJson: JSON.stringify(record.errors),
    tokenCount: record.tokenCount,
    searchText,
    timestamp: record.timestamp,
  });
}

export function listTurnRecords(
  db: Database.Database,
  sessionId: string,
): TurnRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM turn_ledger
       WHERE session_id = ?
       ORDER BY turn ASC`,
    )
    .all(sessionId) as TurnLedgerRow[];
  return rows.map(rowToTurnRecord);
}

export function getTurnRecord(
  db: Database.Database,
  sessionId: string,
  turn: number,
): TurnRecord | null {
  const row = db
    .prepare("SELECT * FROM turn_ledger WHERE session_id = ? AND turn = ?")
    .get(sessionId, turn) as TurnLedgerRow | undefined;
  return row ? rowToTurnRecord(row) : null;
}

export function listArtifactIdsForTurn(
  db: Database.Database,
  sessionId: string,
  turn: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT id FROM context_artifacts
       WHERE session_id = ? AND created_turn = ?`,
    )
    .all(sessionId, turn) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function insertTurnDigest(
  db: Database.Database,
  sessionId: string,
  digest: TurnDigest,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO turn_digests (session_id, turn, digest_json, created_at)
     VALUES (@sessionId, @turn, @digestJson, @createdAt)`,
  ).run({
    sessionId,
    turn: digest.turnId,
    digestJson: JSON.stringify(digest),
    createdAt: Date.now(),
  });
}

export function insertActivityEntries(
  db: Database.Database,
  sessionId: string,
  entries: ActivityEntry[],
): void {
  if (entries.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO activity_log (session_id, turn, type, summary, artifact_ref, created_at)
     VALUES (@sessionId, @turn, @type, @summary, @artifactRef, @createdAt)`,
  );
  const createdAt = Date.now();
  for (const entry of entries) {
    stmt.run({
      sessionId,
      turn: entry.turn,
      type: entry.type,
      summary: entry.summary,
      artifactRef: entry.artifactRef ?? null,
      createdAt,
    });
  }
}

export function listActivityEntries(
  db: Database.Database,
  sessionId: string,
  limit: number,
): ActivityEntry[] {
  const rows = db
    .prepare(
      `SELECT turn, type, summary, artifact_ref
       FROM activity_log
       WHERE session_id = ?
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(sessionId, limit) as Array<{
    turn: number;
    type: string;
    summary: string;
    artifact_ref: string | null;
  }>;
  return rows.reverse().map((row) => ({
    turn: row.turn,
    type: row.type as ActivityEntry["type"],
    summary: row.summary,
    artifactRef: row.artifact_ref ?? undefined,
  }));
}

export interface PersistedExtractionState {
  openErrors: OpenError[];
  testFailed: boolean;
  recentDecisions: Array<{ summary: string; turn: number }>;
  recentConstraints: string[];
  lastUserIntent: string;
}

export function getExtractionState(
  db: Database.Database,
  sessionId: string,
): PersistedExtractionState | null {
  const row = db
    .prepare("SELECT state_json FROM extraction_state WHERE session_id = ?")
    .get(sessionId) as { state_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.state_json) as PersistedExtractionState;
}

export function upsertExtractionState(
  db: Database.Database,
  sessionId: string,
  state: PersistedExtractionState,
): void {
  db.prepare(
    `INSERT INTO extraction_state (session_id, state_json, updated_at)
     VALUES (@sessionId, @stateJson, @updatedAt)
     ON CONFLICT(session_id) DO UPDATE SET
       state_json = excluded.state_json,
       updated_at = excluded.updated_at`,
  ).run({
    sessionId,
    stateJson: JSON.stringify(state),
    updatedAt: Date.now(),
  });
}

export function getSessionCheckpoint(
  db: Database.Database,
  sessionId: string,
): SessionCheckpoint | null {
  const row = db
    .prepare("SELECT checkpoint_json FROM session_checkpoints WHERE session_id = ?")
    .get(sessionId) as { checkpoint_json: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.checkpoint_json) as SessionCheckpoint;
}

export function upsertSessionCheckpoint(
  db: Database.Database,
  sessionId: string,
  checkpoint: SessionCheckpoint,
): void {
  db.prepare(
    `INSERT INTO session_checkpoints (session_id, checkpoint_json, updated_at)
     VALUES (@sessionId, @checkpointJson, @updatedAt)
     ON CONFLICT(session_id) DO UPDATE SET
       checkpoint_json = excluded.checkpoint_json,
       updated_at = excluded.updated_at`,
  ).run({
    sessionId,
    checkpointJson: JSON.stringify(checkpoint),
    updatedAt: Date.now(),
  });
}

export function getTurnDigest(
  db: Database.Database,
  sessionId: string,
  turn: number,
): TurnDigest | null {
  const row = db
    .prepare("SELECT digest_json FROM turn_digests WHERE session_id = ? AND turn = ?")
    .get(sessionId, turn) as { digest_json: string } | undefined;
  if (!row) return null;
  return normalizeStoredTurnDigest(JSON.parse(row.digest_json));
}

export function listTurnDigests(
  db: Database.Database,
  sessionId: string,
): TurnDigest[] {
  const rows = db
    .prepare(
      `SELECT digest_json FROM turn_digests
       WHERE session_id = ?
       ORDER BY turn ASC`,
    )
    .all(sessionId) as Array<{ digest_json: string }>;
  return rows.map((row) => normalizeStoredTurnDigest(JSON.parse(row.digest_json)));
}

function normalizeStoredTurnDigest(raw: TurnDigest): TurnDigest {
  const decisions = (raw.decisions ?? []).map((d) =>
    typeof d === "string" ? { summary: d } : d,
  );
  return {
    ...raw,
    filesWritten: raw.filesWritten ?? [],
    decisions,
  };
}

export function listSessionArtifacts(
  db: Database.Database,
  sessionId: string,
): ContextArtifact[] {
  const rows = db
    .prepare(
      `SELECT * FROM context_artifacts
       WHERE session_id = ?
       ORDER BY created_turn ASC, id ASC`,
    )
    .all(sessionId) as ArtifactRow[];
  return rows.map(rowToArtifact);
}

export function countSessionArtifacts(
  db: Database.Database,
  sessionId: string,
): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM context_artifacts WHERE session_id = ?")
    .get(sessionId) as { count: number };
  return row.count;
}

export function listAllActivityEntries(
  db: Database.Database,
  sessionId: string,
): ActivityEntry[] {
  const rows = db
    .prepare(
      `SELECT turn, type, summary, artifact_ref
       FROM activity_log
       WHERE session_id = ?
       ORDER BY id ASC`,
    )
    .all(sessionId) as Array<{
    turn: number;
    type: string;
    summary: string;
    artifact_ref: string | null;
  }>;
  return rows.map((row) => ({
    turn: row.turn,
    type: row.type as ActivityEntry["type"],
    summary: row.summary,
    artifactRef: row.artifact_ref ?? undefined,
  }));
}

export type ArtifactAccessType = "prompt_included" | "retrieved" | "checkpoint_ref";

export interface SessionStatsRow {
  sessionId: string;
  contextEngineEnabled: boolean;
  pressureEvents: number;
  compactionTriggers: number;
  artifactRetrievals: number;
  totalDistillerSavings: number;
  totalTurns: number;
}

export function insertArtifactAccess(
  db: Database.Database,
  sessionId: string,
  artifactId: string,
  accessType: ArtifactAccessType,
  turn: number,
): void {
  db.prepare(
    `INSERT INTO artifact_access (artifact_id, session_id, access_type, turn, created_at)
     VALUES (@artifactId, @sessionId, @accessType, @turn, @createdAt)`,
  ).run({
    artifactId,
    sessionId,
    accessType,
    turn,
    createdAt: Date.now(),
  });
}

export function getSessionStatsRow(
  db: Database.Database,
  sessionId: string,
): SessionStatsRow | null {
  const row = db
    .prepare(
      `SELECT session_id, context_engine_enabled, pressure_events, compaction_triggers, artifact_retrievals,
              total_distiller_savings, total_turns
       FROM session_stats WHERE session_id = ?`,
    )
    .get(sessionId) as
    | {
        session_id: string;
        context_engine_enabled: number;
        pressure_events: number;
        compaction_triggers: number;
        artifact_retrievals: number;
        total_distiller_savings: number;
        total_turns: number;
      }
    | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id,
    contextEngineEnabled: row.context_engine_enabled === 1,
    pressureEvents: row.pressure_events,
    compactionTriggers: row.compaction_triggers,
    artifactRetrievals: row.artifact_retrievals,
    totalDistillerSavings: row.total_distiller_savings,
    totalTurns: row.total_turns,
  };
}

function ensureSessionStatsRow(
  db: Database.Database,
  sessionId: string,
  contextEngineEnabled = false,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO session_stats (
      session_id, context_engine_enabled, pressure_events, compaction_triggers, artifact_retrievals,
      total_distiller_savings, total_turns, updated_at
    ) VALUES (@sessionId, @contextEngineEnabled, 0, 0, 0, 0, 0, @updatedAt)`,
  ).run({ sessionId, contextEngineEnabled: contextEngineEnabled ? 1 : 0, updatedAt: Date.now() });
}

export function incrementSessionStat(
  db: Database.Database,
  sessionId: string,
  field: "pressure_events" | "compaction_triggers" | "artifact_retrievals",
  amount = 1,
  contextEngineEnabled = false,
): void {
  ensureSessionStatsRow(db, sessionId, contextEngineEnabled);
  db.prepare(
    `UPDATE session_stats
     SET ${field} = ${field} + @amount, updated_at = @updatedAt
     WHERE session_id = @sessionId`,
  ).run({ sessionId, amount, updatedAt: Date.now() });
}

export function finalizeSessionStats(
  db: Database.Database,
  sessionId: string,
  totalTurns: number,
  contextEngineEnabled = false,
): SessionStatsRow {
  ensureSessionStatsRow(db, sessionId, contextEngineEnabled);
  const savingsRow = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens - output_tokens), 0) AS savings
       FROM distiller_stats WHERE session_id = ?`,
    )
    .get(sessionId) as { savings: number };

  db.prepare(
    `UPDATE session_stats
     SET total_turns = @totalTurns,
         total_distiller_savings = @savings,
         context_engine_enabled = @contextEngineEnabled,
         updated_at = @updatedAt
     WHERE session_id = @sessionId`,
  ).run({
    sessionId,
    totalTurns,
    savings: savingsRow.savings,
    contextEngineEnabled: contextEngineEnabled ? 1 : 0,
    updatedAt: Date.now(),
  });

  return getSessionStatsRow(db, sessionId)!;
}

export interface DistillerCostRow {
  distiller: string;
  tool: string;
  runs: number;
  avgInputTokens: number;
  avgSavingsPct: number;
  estimatedCost: number;
}

export function listDistillerCostRanking(
  db: Database.Database,
  sessionId: string,
): DistillerCostRow[] {
  const rows = db
    .prepare(
      `SELECT distiller, tool,
              COUNT(*) AS runs,
              AVG(input_tokens) AS avg_input,
              AVG(savings_pct) AS avg_savings_pct,
              SUM(input_tokens * (1.0 - (savings_pct / 100.0))) AS estimated_cost
       FROM distiller_stats
       WHERE session_id = ?
       GROUP BY distiller, tool
       ORDER BY estimated_cost DESC`,
    )
    .all(sessionId) as Array<{
    distiller: string;
    tool: string;
    runs: number;
    avg_input: number;
    avg_savings_pct: number;
    estimated_cost: number;
  }>;

  return rows.map((row) => ({
    distiller: row.distiller,
    tool: row.tool,
    runs: row.runs,
    avgInputTokens: Math.round(row.avg_input),
    avgSavingsPct: Number(row.avg_savings_pct.toFixed(1)),
    estimatedCost: Math.round(row.estimated_cost),
  }));
}

export function countArtifactAccessByType(
  db: Database.Database,
  sessionId: string,
  accessType: ArtifactAccessType,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM artifact_access
       WHERE session_id = ? AND access_type = ?`,
    )
    .get(sessionId, accessType) as { count: number };
  return row.count;
}
