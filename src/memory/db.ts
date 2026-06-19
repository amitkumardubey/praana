// ============================================================
// PRAANA Memory — SQLite Schema
// ============================================================

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { MemoryEntry, MemoryKind } from "./types.js";
import { EMBEDDING_DIM } from "./embeddings.js";

const REEMBED_NEEDED_KEY = "reembed_needed";
const EMBEDDING_BACKEND_KEY = "embedding_backend";
export const DEDUP_RECONCILED_KEY = "dedup_reconciled_v1";
const SIGNAL_COLUMNS_MIGRATED_KEY = "signal_columns_migrated_v1";
const UTILITY_COLUMNS_MIGRATED_KEY = "utility_columns_migrated_v1";

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  validity      REAL NOT NULL DEFAULT 0.5,
  usefulness    REAL NOT NULL DEFAULT 0.5,
  pinned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  session_id    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_scopes (
  entry_id  TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  scope     TEXT NOT NULL,
  PRIMARY KEY (entry_id, scope)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  context_id  TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  reason      TEXT
);

CREATE TABLE IF NOT EXISTS memory_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts
  USING fts5(content, entry_id UNINDEXED);

CREATE TABLE IF NOT EXISTS pending_reinforcements (
  entry_id   TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  good       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_entries_kind      ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_pinned    ON entries(pinned);
CREATE INDEX IF NOT EXISTS idx_entries_last_seen ON entries(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_scopes_scope      ON entry_scopes(scope);
`;

export interface OpenMemoryDbResult {
  db: Database.Database;
  needsReembed: boolean;
}

export function openMemoryDb(
  path: string,
  embeddingDim: number = EMBEDDING_DIM,
  embeddingBackend?: string,
): OpenMemoryDbResult {
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(BASE_SCHEMA);
  ensureLayerColumns(db);
  ensureSignalColumns(db);
  ensureFtsBackfill(db);
  ensureUtilityColumns(db);

  const needsReembedFromDim = ensureVectorTable(db, embeddingDim);
  const needsReembedFromBackend = embeddingBackend
    ? ensureEmbeddingBackend(db, embeddingBackend)
    : false;
  return {
    db,
    needsReembed: needsReembedFromDim || needsReembedFromBackend,
  };
}

function ensureLayerColumns(db: Database.Database): void {
  const columns = db
    .prepare("PRAGMA table_info(entries)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("layer")) {
    db.exec("ALTER TABLE entries ADD COLUMN layer INTEGER NOT NULL DEFAULT 1");
  }
  if (!names.has("confirmation_count")) {
    db.exec(
      "ALTER TABLE entries ADD COLUMN confirmation_count INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!names.has("retracted")) {
    db.exec("ALTER TABLE entries ADD COLUMN retracted INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * M2 migration: Rename confidence column to validity, add usefulness column.
 * Uses SQLite ALTER TABLE RENAME COLUMN (requires SQLite >= 3.25.0).
 * Idempotent: tracks migration via memory_meta key.
 */
function ensureSignalColumns(db: Database.Database): void {
  if (getMemoryMeta(db, SIGNAL_COLUMNS_MIGRATED_KEY) === "1") return;

  const columns = db
    .prepare("PRAGMA table_info(entries)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  // Rename confidence → validity if still named confidence
  if (names.has("confidence") && !names.has("validity")) {
    db.exec("ALTER TABLE entries RENAME COLUMN confidence TO validity");
  }

  // Add usefulness column if missing
  if (!names.has("usefulness")) {
    db.exec("ALTER TABLE entries ADD COLUMN usefulness REAL NOT NULL DEFAULT 0.5");
  }

  setMemoryMeta(db, SIGNAL_COLUMNS_MIGRATED_KEY, "1");
}

/**
 * M2-part-2 migration: Add used/good columns to pending_reinforcements
 * for utility tracking. Idempotent.
 */
function ensureUtilityColumns(db: Database.Database): void {
  if (getMemoryMeta(db, UTILITY_COLUMNS_MIGRATED_KEY) === "1") return;

  const columns = db
    .prepare("PRAGMA table_info(pending_reinforcements)")
    .all() as Array<{ name: string }>;
  const names = new Set(columns.map((c) => c.name));

  if (!names.has("used")) {
    db.exec("ALTER TABLE pending_reinforcements ADD COLUMN used INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("good")) {
    db.exec("ALTER TABLE pending_reinforcements ADD COLUMN good INTEGER NOT NULL DEFAULT 0");
  }

  setMemoryMeta(db, UTILITY_COLUMNS_MIGRATED_KEY, "1");
}

function ensureFtsBackfill(db: Database.Database): void {
  db.exec(`
    DELETE FROM entries_fts
    WHERE entry_id NOT IN (SELECT id FROM entries);

    INSERT INTO entries_fts (content, entry_id)
    SELECT e.content, e.id
    FROM entries e
    WHERE NOT EXISTS (
      SELECT 1 FROM entries_fts f WHERE f.entry_id = e.id
    );
  `);
}

function ensureVectorTable(db: Database.Database, dim: number): boolean {
  const row = db
    .prepare("SELECT value FROM memory_meta WHERE key = 'embedding_dim'")
    .get() as { value: string } | undefined;
  const storedDim = row ? parseInt(row.value, 10) : EMBEDDING_DIM;
  const reembedFlag = db
    .prepare("SELECT value FROM memory_meta WHERE key = ?")
    .get(REEMBED_NEEDED_KEY) as { value: string } | undefined;

  const vecExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entries_vec'",
    )
    .get();

  if (vecExists && storedDim === dim) {
    return reembedFlag?.value === "1";
  }

  if (vecExists) {
    markReembedNeeded(db);
    db.exec("DROP TABLE IF EXISTS entries_vec");
  }

  db.exec(`
    CREATE VIRTUAL TABLE entries_vec USING vec0(
      entry_id TEXT PRIMARY KEY,
      embedding float[${dim}]
    )
  `);

  db.prepare(
    "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('embedding_dim', ?)",
  ).run(String(dim));

  return Boolean(vecExists) || reembedFlag?.value === "1";
}

export function getStoredEmbeddingBackend(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT value FROM memory_meta WHERE key = ?")
    .get(EMBEDDING_BACKEND_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setStoredEmbeddingBackend(db: Database.Database, backend: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)",
  ).run(EMBEDDING_BACKEND_KEY, backend);
}

export function ensureEmbeddingBackend(
  db: Database.Database,
  backend: string,
): boolean {
  const stored = getStoredEmbeddingBackend(db);
  if (!stored) {
    setStoredEmbeddingBackend(db, backend);
    return false;
  }
  if (stored === backend) return false;

  markReembedNeeded(db);
  setStoredEmbeddingBackend(db, backend);
  return true;
}

export function markReembedNeeded(db: Database.Database): void {
  db.prepare("INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, '1')").run(
    REEMBED_NEEDED_KEY,
  );
}

export function clearReembedNeeded(db: Database.Database): void {
  db.prepare("DELETE FROM memory_meta WHERE key = ?").run(REEMBED_NEEDED_KEY);
}

export function isReembedPending(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT value FROM memory_meta WHERE key = ?")
    .get(REEMBED_NEEDED_KEY) as { value: string } | undefined;
  return row?.value === "1";
}

export function getMemoryMeta(
  db: Database.Database,
  key: string,
): string | undefined {
  const row = db
    .prepare("SELECT value FROM memory_meta WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMemoryMeta(
  db: Database.Database,
  key: string,
  value: string,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO memory_meta (key, value) VALUES (?, ?)",
  ).run(key, value);
}

export function incrementConfirmationCount(
  db: Database.Database,
  id: string,
  delta = 1,
): void {
  db.prepare(
    "UPDATE entries SET confirmation_count = confirmation_count + ? WHERE id = ?",
  ).run(delta, id);
}

export function mergeEntryMetadata(
  db: Database.Database,
  keeperId: string,
  duplicate: MemoryEntry,
): void {
  incrementConfirmationCount(db, keeperId, duplicate.confirmation_count + 1);
  reinforceEntry(db, keeperId, 0.08);
  const keeper = getEntryById(db, keeperId);
  if (!keeper) return;
  const lastSeenAt = Math.max(keeper.last_seen_at, duplicate.last_seen_at);
  db.prepare("UPDATE entries SET last_seen_at = ? WHERE id = ?").run(
    lastSeenAt,
    keeperId,
  );
  if (duplicate.pinned) {
    db.prepare("UPDATE entries SET pinned = 1 WHERE id = ?").run(keeperId);
  }
}

export function getEmbedding(
  db: Database.Database,
  entryId: string,
): Float32Array | null {
  const vecExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entries_vec'",
    )
    .get();
  if (!vecExists) return null;

  const row = db
    .prepare("SELECT embedding FROM entries_vec WHERE entry_id = ?")
    .get(entryId) as { embedding: Buffer } | undefined;
  if (!row) return null;
  return new Float32Array(
    row.embedding.buffer,
    row.embedding.byteOffset,
    row.embedding.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

export function countVectorEmbeddings(db: Database.Database): number {
  const vecExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='entries_vec'",
    )
    .get();
  if (!vecExists) return 0;
  const row = db.prepare("SELECT COUNT(*) as c FROM entries_vec").get() as {
    c: number;
  };
  return row.c;
}

// ---- Entry CRUD ----

export function insertEntry(db: Database.Database, e: MemoryEntry): void {
  const stmt = db.prepare(
    `INSERT INTO entries (id, kind, content, validity, usefulness, pinned, layer, confirmation_count, created_at, last_seen_at, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    e.id,
    e.kind,
    e.content,
    e.validity,
    e.usefulness,
    e.pinned ? 1 : 0,
    e.layer,
    e.confirmation_count,
    e.created_at,
    e.last_seen_at,
    e.session_id,
  );

  const scopeStmt = db.prepare(
    `INSERT OR IGNORE INTO entry_scopes (entry_id, scope) VALUES (?, ?)`,
  );
  for (const scope of e.scopes) {
    scopeStmt.run(e.id, scope);
  }

  db.prepare(
    "INSERT INTO entries_fts (content, entry_id) VALUES (?, ?)",
  ).run(e.content, e.id);
}

export function touchEntry(db: Database.Database, id: string, now: number): void {
  db.prepare("UPDATE entries SET last_seen_at = ? WHERE id = ?").run(now, id);
}

export function reinforceEntry(db: Database.Database, id: string, alpha = 0.15): void {
  db.prepare(
    `
    UPDATE entries
    SET validity = MIN(1.0, validity + (1.0 - validity) * ?), last_seen_at = ?
    WHERE id = ?
  `,
  ).run(alpha, Date.now(), id);
}

// TODO: wire into a scheduled validity-decay pass (not yet called from production code).
export function weakenEntry(db: Database.Database, id: string, beta = 0.3): void {
  db.prepare(
    `UPDATE entries SET validity = validity * (1.0 - ?) WHERE id = ?`,
  ).run(beta, id);
}

export function stampReinforcement(
  db: Database.Database,
  entryId: string,
  sessionId: string,
): void {
  db.prepare(
    `
    INSERT OR IGNORE INTO pending_reinforcements (entry_id, session_id, ts, used, good)
    VALUES (?, ?, ?, 0, 0)
  `,
  ).run(entryId, sessionId, Date.now());
}

/** Mark whether a surfaced entry was actually used (acted on) during the session. */
export function markReinforcementUsed(
  db: Database.Database,
  entryId: string,
  sessionId: string,
  used: boolean,
): void {
  db.prepare(
    `UPDATE pending_reinforcements SET used = ? WHERE entry_id = ? AND session_id = ?`,
  ).run(used ? 1 : 0, entryId, sessionId);
}

/** Utility update constants. */
const UTILITY_ALPHA_USE = 0.15;  // boost when used ∧ good
const UTILITY_BETA_IDLE = 0.05;  // decay when ¬used

/** Apply a delta update to a single entry's usefulness, clamped to [0, 1]. */
function updateUsefulness(
  db: Database.Database,
  id: string,
  mode: "boost" | "decay" | "neutral",
): void {
  if (mode === "neutral") return;

  if (mode === "boost") {
    db.prepare(
      `UPDATE entries SET usefulness = MIN(1.0, usefulness + (1.0 - usefulness) * ?) WHERE id = ?`,
    ).run(UTILITY_ALPHA_USE, id);
  } else {
    db.prepare(
      `UPDATE entries SET usefulness = usefulness * (1.0 - ?) WHERE id = ?`,
    ).run(UTILITY_BETA_IDLE, id);
  }
}

export function flushReinforcements(db: Database.Database, sessionId: string): void {
  const rows = db
    .prepare(
      "SELECT entry_id, used, good FROM pending_reinforcements WHERE session_id = ?",
    )
    .all(sessionId) as { entry_id: string; used: number; good: number }[];

  for (const { entry_id, used, good } of rows) {
    // Pass 1: validity reinforcement (always — being surfaced confirms truth)
    reinforceEntry(db, entry_id);

    // Pass 2: utility update based on surfaced+used+outcome
    if (used === 1 && good === 1) {
      updateUsefulness(db, entry_id, "boost");
    } else if (used === 1 && good === 0) {
      // Decision: neutral — session-success bit is too noisy to penalize a used memory.
      // TODO(scorecard): revisit toward a small decay once #99 delivers reliable signal.
      updateUsefulness(db, entry_id, "neutral");
    } else {
      // ¬used — idle decay regardless of good/bad
      updateUsefulness(db, entry_id, "decay");
    }
  }

  db.prepare("DELETE FROM pending_reinforcements WHERE session_id = ?").run(sessionId);
}

export function getEntryById(db: Database.Database, id: string): MemoryEntry | undefined {
  const row = db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as Record<
    string,
    unknown
  > | undefined;
  if (!row) return undefined;
  return rowToEntry(db, row);
}

export function getAllEntries(db: Database.Database): MemoryEntry[] {
  const rows = db
    .prepare("SELECT * FROM entries ORDER BY created_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map((r) => rowToEntry(db, r));
}

export function getEntriesByScope(db: Database.Database, scopes: string[]): MemoryEntry[] {
  const placeholders = scopes.map(() => "?").join(",");
  const sql = `
    SELECT e.* FROM entries e
    JOIN entry_scopes es ON e.id = es.entry_id
    WHERE es.scope IN (${placeholders})
    GROUP BY e.id
    HAVING COUNT(DISTINCT es.scope) = ${scopes.length}
    ORDER BY e.last_seen_at DESC
  `;
  const rows = db.prepare(sql).all(...scopes) as Record<string, unknown>[];
  return rows.map((r) => rowToEntry(db, r));
}

export function deleteEntry(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM entries WHERE id = ?").run(id);
  db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(id);
  db.prepare("DELETE FROM entries_fts WHERE entry_id = ?").run(id);
}

export function retractMemory(db: Database.Database, id: string): void {
  db.prepare("UPDATE entries SET retracted = 1 WHERE id = ?").run(id);
}

function rowToEntry(db: Database.Database, row: Record<string, unknown>): MemoryEntry {
  const scopes = db
    .prepare("SELECT scope FROM entry_scopes WHERE entry_id = ?")
    .all(row.id) as { scope: string }[];
  return {
    id: row.id as string,
    kind: row.kind as MemoryKind,
    content: row.content as string,
    validity: (row.validity ?? row.confidence) as number,  // back-compat: read from validity or legacy confidence
    usefulness: (row.usefulness as number | undefined) ?? 0.5,  // default 0.5 for pre-migration rows
    pinned: row.pinned === 1,
    layer: (row.layer as number | undefined) === 2 ? 2 : 1,
    confirmation_count: (row.confirmation_count as number | undefined) ?? 0,
    created_at: row.created_at as number,
    last_seen_at: row.last_seen_at as number,
    session_id: row.session_id as string,
    scopes: scopes.map((s) => s.scope),
    retracted: (row.retracted as number | undefined) === 1,
  };
}

// ---- Sessions ----

export function startSessionRow(
  db: Database.Database,
  s: {
    id: string;
    agent: string;
    user_id: string;
    context_id: string;
    started_at: number;
  },
): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, user_id, context_id, started_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(s.id, s.agent, s.user_id, s.context_id, s.started_at);
}

export function endSessionRow(
  db: Database.Database,
  id: string,
  endedAt: number,
  reason: string,
): void {
  db.prepare("UPDATE sessions SET ended_at = ?, reason = ? WHERE id = ?").run(
    endedAt,
    reason,
    id,
  );
}

// ---- Embeddings ----

export function upsertEmbedding(
  db: Database.Database,
  entryId: string,
  embedding: Float32Array,
): void {
  const buf = Buffer.from(embedding.buffer);
  db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(entryId);
  db.prepare("INSERT INTO entries_vec (entry_id, embedding) VALUES (?, ?)").run(
    entryId,
    buf,
  );
}

export function searchByVector(
  db: Database.Database,
  query: Float32Array,
  k: number,
): Array<{ entry_id: string; distance: number }> {
  const buf = Buffer.from(query.buffer);
  return db
    .prepare(
      `SELECT entry_id, distance FROM entries_vec
     WHERE embedding MATCH ? AND k = ?
     ORDER BY distance`,
    )
    .all(buf, k) as Array<{ entry_id: string; distance: number }>;
}

export function searchByFts(
  db: Database.Database,
  query: string,
  k: number,
  filters: { scopes?: string[]; kinds?: MemoryKind[] } = {},
): Array<{ entry_id: string; rank: number }> {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const params: Array<string | number> = [ftsQuery];
  const joins: string[] = [];
  const wheres: string[] = ["entries_fts MATCH ?"];

  if (filters.kinds && filters.kinds.length > 0) {
    joins.push("JOIN entries e ON e.id = entries_fts.entry_id");
    wheres.push(`e.kind IN (${filters.kinds.map(() => "?").join(",")})`);
    params.push(...filters.kinds);
  }

  if (filters.scopes && filters.scopes.length > 0) {
    wheres.push(`
      entries_fts.entry_id IN (
        SELECT entry_id
        FROM entry_scopes
        WHERE scope IN (${filters.scopes.map(() => "?").join(",")})
        GROUP BY entry_id
        HAVING COUNT(DISTINCT scope) = ${filters.scopes.length}
      )
    `);
    params.push(...filters.scopes);
  }

  params.push(k);

  return db
    .prepare(
      `SELECT entries_fts.entry_id, bm25(entries_fts) AS rank
       FROM entries_fts
       ${joins.join("\n       ")}
       WHERE ${wheres.join(" AND ")}
       ORDER BY rank
       LIMIT ?`,
    )
    .all(...params) as Array<{ entry_id: string; rank: number }>;
}

function buildFtsQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .match(/[a-z0-9_]+/g);
  if (!terms || terms.length === 0) return "";

  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}
