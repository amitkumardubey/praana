// ============================================================
// ARIA Memory — Store
//
// Unified API: remember, recall, digest, pin, session lifecycle.
// ============================================================

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import {
  clearReembedNeeded,
  endSessionRow,
  flushReinforcements,
  getAllEntries,
  getEntriesByScope,
  getEntryById,
  insertEntry,
  openMemoryDb,
  searchByVector,
  stampReinforcement,
  startSessionRow,
  touchEntry,
  upsertEmbedding,
} from "./db.js";
import type { Embedder } from "./types.js";
import { extractLearnings } from "./summarizer.js";
import type {
  Digest,
  MemoryEntry,
  MemoryKind,
  RecallOptions,
  RecallResult,
  RememberOptions,
  SessionContext,
  SessionEvent,
  SummarizerLLM,
} from "./types.js";

function certaintyToConfidence(c: "high" | "medium" | "low"): number {
  return c === "high" ? 0.8 : c === "medium" ? 0.5 : 0.3;
}

function effectiveConfidence(entry: MemoryEntry, now: number): number {
  const days = (now - entry.created_at) / (1000 * 60 * 60 * 24);
  const decay = Math.pow(0.95, days);          // 5% per day
  return entry.confidence * decay;
}

export class MemoryStore {
  private db: Database.Database;
  private embedder: Embedder;
  private summarizer: SummarizerLLM | null;
  private defaultScopes: string[] = [];
  private sessionId: string = "";
  /** True while a background re-embed migration is running. */
  private reembedding = false;
  private reembedPromise: Promise<void> | null = null;

  constructor(opts: {
    dbPath: string;
    embedder: Embedder;
    summarizer?: SummarizerLLM | null;
    /**
     * Override the auto-detected needsReembed flag from openMemoryDb.
     * Intended for tests that use :memory: DBs with explicit control.
     */
    needsReembed?: boolean;
  }) {
    const opened = openMemoryDb(opts.dbPath, opts.embedder.dim);
    this.db = opened.db;
    this.embedder = opts.embedder;
    this.summarizer = opts.summarizer ?? null;
    if (opts.needsReembed ?? opened.needsReembed) {
      this.reembedPromise = this.reembedAllEntries();
    }
  }

  close(): void {
    this.db.close();
  }

  // ---- Session lifecycle ----

  async sessionStart(ctx: SessionContext): Promise<Digest> {
    await this.waitForReembed();

    this.sessionId = ulid();
    this.defaultScopes = this.buildDefaultScopes(ctx);

    startSessionRow(this.db, {
      id: this.sessionId,
      agent: ctx.agent,
      user_id: ctx.user_id,
      context_id: ctx.context_id,
      started_at: ctx.time,
    });

    return this.buildDigest(ctx);
  }

  async sessionEnd(reason: string, events?: SessionEvent[]): Promise<void> {
    flushReinforcements(this.db, this.sessionId);

    const now = Date.now();
    endSessionRow(this.db, this.sessionId, now, reason);

    if (events && events.length > 0 && this.summarizer) {
      const learnings = await extractLearnings(this.summarizer, events);
      for (const l of learnings) {
        await this.remember(l.content, {
          kind: l.kind,
          certainty: l.certainty,
          scope: l.scope_hints ?? this.defaultScopes,
        });
      }
    }
  }

  // ---- Core operations ----

  async remember(content: string, opts: RememberOptions = {}): Promise<{ id: string }> {
    const id = ulid();
    const now = Date.now();
    const kind = opts.kind ?? "fact";
    const confidence = certaintyToConfidence(opts.certainty ?? "medium");
    const scopes = opts.scope ?? this.defaultScopes;

    const entry: MemoryEntry = {
      id,
      kind,
      content: content.slice(0, 1000),
      confidence,
      pinned: opts.pinned ?? false,
      created_at: now,
      last_seen_at: now,
      session_id: this.sessionId,
      scopes,
    };

    insertEntry(this.db, entry);

    // Embedding (fire-and-forget)
    this.embedder.embed(content).then((vec) => {
      upsertEmbedding(this.db, id, vec);
    }).catch(() => { /* embedder failure is non-fatal */ });

    return { id };
  }

  async recall(query: string, opts: RecallOptions = {}): Promise<RecallResult> {
    const limit = opts.limit ?? 10;
    const queryScopes = opts.scope ?? this.defaultScopes;
    const now = Date.now();

    if (this.reembedding) {
      console.warn("[memory] Vector migration in progress — recall quality may be reduced until re-embed completes.");
    }

    // Strategy: vector search for candidates, then filter + re-rank
    let candidates: MemoryEntry[] = [];

    try {
      const qvec = await this.embedder.embed(query);
      const hits = searchByVector(this.db, qvec, limit * 4);
      for (const h of hits) {
        const e = getEntryById(this.db, h.entry_id);
        if (e) candidates.push(e);
      }
    } catch {
      // Vector search failed — fall back to scope-only
    }

    // If vector returned nothing useful, fall back to all entries in scope
    if (candidates.length === 0) {
      candidates = getEntriesByScope(this.db, queryScopes);
    }

    // Enforce strict scope isolation: entry must include ALL requested scopes.
    // This keeps vector and fallback paths consistent.
    if (queryScopes.length > 0) {
      const queryScopeSet = new Set(queryScopes);
      candidates = candidates.filter((e) => {
        const entryScopeSet = new Set(e.scopes);
        for (const scope of queryScopeSet) {
          if (!entryScopeSet.has(scope)) return false;
        }
        return true;
      });
    }

    // Filter by kind
    if (opts.kinds && opts.kinds.length > 0) {
      const kindSet = new Set(opts.kinds);
      candidates = candidates.filter((e) => kindSet.has(e.kind));
    }

    // Score & rank
    const scored = candidates.map((e) => {
      const conf = effectiveConfidence(e, now);
      // Recency bonus: 0–0.2 based on days since last seen (max at 0 days)
      const daysSince = (now - e.last_seen_at) / (1000 * 60 * 60 * 24);
      const recency = Math.max(0, 0.2 - daysSince * 0.02);
      // Pin bonus
      const pin = e.pinned ? 0.3 : 0;
      const score = conf + recency + pin;
      return { entry: e, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Touch recalled entries
    const top = scored.slice(0, limit);
    for (const s of top) {
      touchEntry(this.db, s.entry.id, now);
      stampReinforcement(this.db, s.entry.id, this.sessionId);
    }

    return {
      entries: top.map((s) => ({
        id: s.entry.id,
        kind: s.entry.kind,
        content: s.entry.content,
        confidence: s.entry.confidence,
        scopes: s.entry.scopes,
        score: Math.round(s.score * 1000) / 1000,
      })),
    };
  }

  async pin(id: string): Promise<void> {
    this.db.prepare("UPDATE entries SET pinned = 1 WHERE id = ?").run(id);
  }

  async unpin(id: string): Promise<void> {
    this.db.prepare("UPDATE entries SET pinned = 0 WHERE id = ?").run(id);
  }

  getAllEntries(): MemoryEntry[] {
    return getAllEntries(this.db);
  }

  /** Re-embed all entries after vector dimension migration. Runs in the background. */
  async reembedAllEntries(): Promise<void> {
    this.reembedding = true;
    const entries = getAllEntries(this.db);
    console.log(`[memory] Re-embedding ${entries.length} entries after dimension migration…`);
    let failed = 0;
    for (const e of entries) {
      try {
        const vec = await this.embedder.embed(e.content);
        upsertEmbedding(this.db, e.id, vec);
      } catch (err) {
        failed++;
        console.warn(`[memory] Failed to re-embed entry ${e.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.reembedding = false;
    if (failed > 0) {
      console.warn(`[memory] Re-embed migration complete — ${failed}/${entries.length} entries failed. Recall quality may be degraded.`);
    } else {
      clearReembedNeeded(this.db);
      console.log(`[memory] Re-embed migration complete — ${entries.length} entries updated.`);
    }
  }

  // ---- Internal ----

  private async waitForReembed(): Promise<void> {
    if (this.reembedPromise) {
      await this.reembedPromise;
      this.reembedPromise = null;
    }
  }

  private buildDefaultScopes(ctx: SessionContext): string[] {
    return [
      `user:${ctx.user_id}`,
      `agent:${ctx.agent}`,
      `context:${ctx.context_id}`,
    ];
  }

  private async buildDigest(ctx: SessionContext): Promise<Digest> {
    const now = Date.now();
    const entries = getEntriesByScope(this.db, this.defaultScopes);

    // Score all entries
    const scored = entries.map((e) => ({
      entry: e,
      score: effectiveConfidence(e, now) + (e.pinned ? 0.3 : 0),
    }));
    scored.sort((a, b) => b.score - a.score);

    // Build markdown
    const lines: string[] = [];
    const included: string[] = [];
    const kindOrder: MemoryKind[] = ["constraint", "preference", "fact", "pattern", "decision", "mistake"];

    for (const kind of kindOrder) {
      const bucket = scored.filter((s) => s.entry.kind === kind);
      if (bucket.length === 0) continue;
      const title = kind.charAt(0).toUpperCase() + kind.slice(1) + (kind === "mistake" ? "s to avoid" : "s");
      lines.push(`## ${title}`);
      for (const s of bucket) {
        lines.push(`- ${s.entry.content}`);
        included.push(s.entry.id);
      }
      lines.push("");
    }

    if (lines.length > 0) {
      lines.push("Use recall(\"...\") for anything not shown.");
    }

    const markdown = lines.join("\n").trimEnd();
    return {
      markdown: markdown || "_No memories for this scope yet._",
      empty: included.length === 0,
      entriesIncluded: included,
    };
  }
}
