// ============================================================
// ARIA Memory — SQLite Schema
// ============================================================

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { MemoryEntry, MemoryKind } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  content       TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 0.5,
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

CREATE VIRTUAL TABLE IF NOT EXISTS entries_vec USING vec0(
  entry_id TEXT PRIMARY KEY,
  embedding float[384]
);

CREATE INDEX IF NOT EXISTS idx_entries_kind      ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_pinned    ON entries(pinned);
CREATE INDEX IF NOT EXISTS idx_entries_last_seen ON entries(last_seen_at);
CREATE INDEX IF NOT EXISTS idx_scopes_scope      ON entry_scopes(scope);
`;

export function openMemoryDb(path: string): Database.Database {
  const db = new Database(path);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// ---- Entry CRUD ----

export function insertEntry(db: Database.Database, e: MemoryEntry): void {
  const stmt = db.prepare(
    `INSERT INTO entries (id, kind, content, confidence, pinned, created_at, last_seen_at, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run(e.id, e.kind, e.content, e.confidence, e.pinned ? 1 : 0,
    e.created_at, e.last_seen_at, e.session_id);

  const scopeStmt = db.prepare(
    `INSERT OR IGNORE INTO entry_scopes (entry_id, scope) VALUES (?, ?)`
  );
  for (const scope of e.scopes) {
    scopeStmt.run(e.id, scope);
  }
}

export function touchEntry(db: Database.Database, id: string, now: number): void {
  db.prepare("UPDATE entries SET last_seen_at = ? WHERE id = ?").run(now, id);
}

export function getEntryById(db: Database.Database, id: string): MemoryEntry | undefined {
  const row = db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as any;
  if (!row) return undefined;
  return rowToEntry(db, row);
}

export function getAllEntries(db: Database.Database): MemoryEntry[] {
  const rows = db.prepare("SELECT * FROM entries ORDER BY created_at DESC").all() as any[];
  return rows.map((r) => rowToEntry(db, r));
}

export function getEntriesByScope(db: Database.Database, scopes: string[]): MemoryEntry[] {
  // AND-scoping: entry must have ALL requested scopes
  const placeholders = scopes.map(() => "?").join(",");
  const sql = `
    SELECT e.* FROM entries e
    JOIN entry_scopes es ON e.id = es.entry_id
    WHERE es.scope IN (${placeholders})
    GROUP BY e.id
    HAVING COUNT(DISTINCT es.scope) = ${scopes.length}
    ORDER BY e.last_seen_at DESC
  `;
  const rows = db.prepare(sql).all(...scopes) as any[];
  return rows.map((r) => rowToEntry(db, r));
}

export function deleteEntry(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM entries WHERE id = ?").run(id);
  // cascades to scopes and vec via FK + manual cleanup
  db.prepare("DELETE FROM entries_vec WHERE rowid IN (SELECT rowid FROM entries_vec WHERE embedding MATCH (SELECT embedding FROM entries_vec WHERE rowid = (SELECT rowid FROM entries_vec WHERE embedding IS NOT NULL LIMIT 1)) AND k = 1)").run();
}

function rowToEntry(db: Database.Database, row: any): MemoryEntry {
  const scopes = db.prepare("SELECT scope FROM entry_scopes WHERE entry_id = ?").all(row.id) as { scope: string }[];
  return {
    id: row.id,
    kind: row.kind as MemoryKind,
    content: row.content,
    confidence: row.confidence,
    pinned: row.pinned === 1,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    session_id: row.session_id,
    scopes: scopes.map((s) => s.scope),
  };
}

// ---- Sessions ----

export function startSessionRow(db: Database.Database, s: {
  id: string; agent: string; user_id: string; context_id: string; started_at: number;
}): void {
  db.prepare(
    `INSERT INTO sessions (id, agent, user_id, context_id, started_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(s.id, s.agent, s.user_id, s.context_id, s.started_at);
}

export function endSessionRow(db: Database.Database, id: string, endedAt: number, reason: string): void {
  db.prepare("UPDATE sessions SET ended_at = ?, reason = ? WHERE id = ?")
    .run(endedAt, reason, id);
}

// ---- Embeddings ----

export function upsertEmbedding(db: Database.Database, entryId: string, embedding: Float32Array): void {
  const buf = Buffer.from(embedding.buffer);
  db.prepare("DELETE FROM entries_vec WHERE entry_id = ?").run(entryId);
  db.prepare("INSERT INTO entries_vec (entry_id, embedding) VALUES (?, ?)")
    .run(entryId, buf);
}

export function searchByVector(
  db: Database.Database,
  query: Float32Array,
  k: number,
): Array<{ entry_id: string; distance: number }> {
  const buf = Buffer.from(query.buffer);
  return db.prepare(
    `SELECT entry_id, distance FROM entries_vec
     WHERE embedding MATCH ? AND k = ?
     ORDER BY distance`
  ).all(buf, k) as Array<{ entry_id: string; distance: number }>;
}
