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
  deleteEntry,
  retractMemory as retractMemoryDb,
  openMemoryDb,
  reinforceEntry,
  searchByFts,
  searchByVector,
  stampReinforcement,
  startSessionRow,
  touchEntry,
  upsertEmbedding,
  weakenEntry,
} from "./db.js";
import type { Embedder } from "./types.js";
import { extractLearnings, summarizeTurns } from "./summarizer.js";
import {
  CONTRADICTION_MATCH_THRESHOLD,
  DUPLICATE_MATCH_THRESHOLD,
  isContradiction,
  isNearDuplicate,
} from "./dedup.js";
import type {
  Digest,
  ExtractedLearning,
  MemoryEntry,
  MemoryKind,
  RecallOptions,
  RecallResult,
  RememberOptions,
  SessionContext,
  SessionEvent,
  SummarizerLLM,
} from "./types.js";
import { isMemoryKind, MEMORY_KINDS } from "./types.js";
import { effectiveConfidence, digestScore } from "./confidence.js";

function certaintyToConfidence(c: "high" | "medium" | "low"): number {
  return c === "high" ? 0.8 : c === "medium" ? 0.5 : 0.3;
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  return /\babort(ed)?\b/i.test(err.message);
}

function lexicalMatchScore(
  entry: MemoryEntry,
  terms: string[],
  rankScore: number,
): number {
  if (terms.length === 0) return 0;

  const content = entry.content.toLowerCase();
  const matched = terms.filter((term) => content.includes(term)).length;
  const coverage = matched / terms.length;
  return 0.6 + coverage * 0.3 + rankScore * 0.1;
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

  /** Get the summarizer LLM (may be null if summarizer is disabled). */
  getSummarizer(): SummarizerLLM | null {
    return this.summarizer;
  }

  getEntryCount(): number {
    return getAllEntries(this.db).length;
  }

  // ---- Session lifecycle ----

  async sessionStart(ctx: SessionContext): Promise<Digest> {
    await this.waitForReembed();

    this.sessionId = ulid();
    this.defaultScopes = this.buildDefaultScopes(ctx);

    const pruned = await this.prune();
    if (pruned > 0) {
      console.log(`[memory] Pruned ${pruned} stale Layer 1 ${pruned === 1 ? "entry" : "entries"}`);
    }

    startSessionRow(this.db, {
      id: this.sessionId,
      agent: ctx.agent,
      user_id: ctx.user_id,
      context_id: ctx.context_id,
      started_at: ctx.time,
    });

    return this.buildDigest(ctx, ctx.recall_min_score);
  }

  async sessionEnd(reason: string, events?: SessionEvent[]): Promise<void> {
    flushReinforcements(this.db, this.sessionId);

    const now = Date.now();
    endSessionRow(this.db, this.sessionId, now, reason);

    if (events && events.length > 0 && this.summarizer) {
      try {
        const learnings = await extractLearnings(this.summarizer, events);
        for (const l of learnings) {
          await this.storeLearning(l);
        }
      } catch (err) {
        if (isAbortLikeError(err)) {
          console.warn("[memory] Session-end summarizer aborted; skipping learnings for this session.");
          return;
        }
        throw err;
      }
    }
  }

  /**
   * Compress a batch of old turns into episodic facts.
   * Returns the number of facts stored.
   */
  async compressTurns(events: SessionEvent[]): Promise<number> {
    if (!this.summarizer) return 0;
    try {
      const facts = await summarizeTurns(this.summarizer, events);
      for (const fact of facts) {
        await this.remember(fact.content, {
          kind: fact.kind,
          certainty: fact.certainty,
          pinned: false,
        });
      }
      return facts.length;
    } catch (err) {
      if (isAbortLikeError(err)) {
        console.warn("[memory] Turn compression aborted; skipping.");
        return 0;
      }
      throw err;
    }
  }

  // ---- Core operations ----

  async remember(content: string, opts: RememberOptions = {}): Promise<{ id: string }> {
    const id = ulid();
    const now = Date.now();
    const kind = opts.kind ?? "fact";
    if (!isMemoryKind(kind)) {
      throw new Error(
        `Invalid memory kind: '${kind}'. Valid kinds: ${MEMORY_KINDS.join(", ")}`,
      );
    }
    const confidence = certaintyToConfidence(opts.certainty ?? "medium");
    const scopes = opts.scope ?? this.defaultScopes;

    const entry: MemoryEntry = {
      id,
      kind,
      content: content.slice(0, 1000),
      confidence,
      pinned: opts.pinned ?? false,
      layer: 1,
      confirmation_count: 0,
      created_at: now,
      last_seen_at: now,
      session_id: this.sessionId,
      scopes,
      retracted: false,
    };

    insertEntry(this.db, entry);

    // Embedding (fire-and-forget)
    this.embedder.embed(content).then((vec) => {
      upsertEmbedding(this.db, id, vec);
    }).catch(() => { /* embedder failure is non-fatal */ });

    return { id };
  }

  private async storeLearning(learning: ExtractedLearning): Promise<void> {
    const similar = await this.recall(learning.content, {
      limit: 3,
      kinds: [learning.kind],
    });

    const duplicate = similar.entries.find((e) => {
      const existing = getEntryById(this.db, e.id);
      if (!existing) return false;
      return isNearDuplicate(existing.content, learning.content, Math.max(e.match, e.score));
    });
    if (duplicate) {
      reinforceEntry(this.db, duplicate.id, 0.08);
      this.db
        .prepare("UPDATE entries SET confirmation_count = confirmation_count + 1 WHERE id = ?")
        .run(duplicate.id);
      return;
    }

    for (const candidate of similar.entries) {
      if (candidate.match < CONTRADICTION_MATCH_THRESHOLD && candidate.score < CONTRADICTION_MATCH_THRESHOLD) {
        continue;
      }
      const existing = getEntryById(this.db, candidate.id);
      if (!existing) continue;
      if (await isContradiction(existing.content, learning.content, this.summarizer)) {
        weakenEntry(this.db, candidate.id, 0.15);
      }
    }

    await this.remember(learning.content, {
      kind: learning.kind,
      certainty: learning.certainty,
      scope: learning.scope_hints ?? this.defaultScopes,
    });
  }

  async recall(query: string, opts: RecallOptions = {}): Promise<RecallResult> {
    const limit = opts.limit ?? 10;
    const queryScopes = opts.scope ?? this.defaultScopes;
    const scopeQueries = this.buildScopeQueries(queryScopes);
    const now = Date.now();

    if (this.reembedding) {
      console.warn("[memory] Vector migration in progress — recall quality may be reduced until re-embed completes.");
    }

    // Strategy: merge reliable keyword hits with vector candidates, then filter + re-rank.
    const candidateScores = new Map<string, { entry: MemoryEntry; matchScore: number }>();
    const terms = queryTerms(query);

    const addCandidate = (entry: MemoryEntry, matchScore: number) => {
      const existing = candidateScores.get(entry.id);
      if (!existing || matchScore > existing.matchScore) {
        candidateScores.set(entry.id, { entry, matchScore });
      }
    };
    const matchesAnyScopeQuery = (entry: MemoryEntry): boolean => {
      if (scopeQueries.length === 0) return true;
      return scopeQueries.some((scopes) => this.entryMatchesScopeQuery(entry, scopes));
    };

    const matchesRequestedFilters = (entry: MemoryEntry): boolean => {
      if (!matchesAnyScopeQuery(entry)) return false;

      if (opts.kinds && opts.kinds.length > 0 && !opts.kinds.includes(entry.kind)) {
        return false;
      }

      return true;
    };

    const ftsHits = scopeQueries.flatMap((scopes) =>
      searchByFts(this.db, query, limit * 4, {
        scopes,
        kinds: opts.kinds,
      }),
    );
    const ftsRanks = ftsHits.map((h) => h.rank);
    const bestFtsRank = Math.min(...ftsRanks);
    const worstFtsRank = Math.max(...ftsRanks);
    for (const h of ftsHits) {
      const e = getEntryById(this.db, h.entry_id);
      if (e) {
        const rankScore = bestFtsRank === worstFtsRank
          ? 1
          : 1 - ((h.rank - bestFtsRank) / (worstFtsRank - bestFtsRank));
        addCandidate(e, lexicalMatchScore(e, terms, rankScore));
      }
    }

    try {
      const qvec = await this.embedder.embed(query);
      const hits = searchByVector(this.db, qvec, limit * 4);
      for (const h of hits) {
        const e = getEntryById(this.db, h.entry_id);
        if (e) {
          const similarity = Math.max(0, 1 - h.distance);
          addCandidate(e, Math.min(similarity, 0.75));
        }
      }
    } catch {
      // Vector search failed — fall back to scope-only
    }

    // If neither search path returned candidates, fall back to all entries in scope.
    if (candidateScores.size === 0) {
      for (const e of this.getEntriesForScopeQueries(scopeQueries)) {
        addCandidate(e, 0);
      }
    }

    let candidates = Array.from(candidateScores.values());
    // Filter out retracted (tombstoned) entries
    candidates = candidates.filter(({ entry }) => !entry.retracted);

    // Enforce strict scope isolation: entry must include ALL requested scopes.
    // This keeps vector and fallback paths consistent.
    candidates = candidates.filter(({ entry }) => matchesAnyScopeQuery(entry));

    // Filter by kind
    if (opts.kinds && opts.kinds.length > 0) {
      const kindSet = new Set(opts.kinds);
      candidates = candidates.filter(({ entry }) => kindSet.has(entry.kind));
    }

    // Vector search is limited before scope filtering by sqlite-vec. If its top
    // hits are outside the requested scopes, preserve the old scoped fallback.
    if (candidates.length === 0 && candidateScores.size > 0) {
      for (const e of this.getEntriesForScopeQueries(scopeQueries)) {
        if (!opts.kinds || opts.kinds.includes(e.kind)) {
          addCandidate(e, 0);
        }
      }
      candidates = Array.from(candidateScores.values()).filter(({ entry }) => {
        return matchesRequestedFilters(entry);
      });
    }

    // Score & rank
    const scored = candidates.map(({ entry: e, matchScore }) => {
      const conf = effectiveConfidence(e, now);
      const match = matchScore;
      // Recency bonus: 0–0.2 based on days since last seen (max at 0 days)
      const daysSince = (now - e.last_seen_at) / (1000 * 60 * 60 * 24);
      const recency = Math.max(0, 0.2 - daysSince * 0.02);
      // Pin bonus
      const pin = e.pinned ? 0.3 : 0;
      const score = matchScore + conf * 0.2 + recency + pin;
      return { entry: e, score, match, conf };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.conf - a.conf;
    });

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
        match: Math.round(s.match * 1000) / 1000,
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

  reinforceFromSuccessfulToolOutcome(entryIds: string[], alpha = 0.08): void {
    const uniqueIds = new Set(entryIds);
    for (const id of uniqueIds) {
      const entry = getEntryById(this.db, id);
      if (!entry) continue;
      reinforceEntry(this.db, id, alpha);
    }
  }

  getAllEntries(): MemoryEntry[] {
    return getAllEntries(this.db);
  }

  /** Promote an entry from Layer 1 to Layer 2 (deep memory). */
  promoteToLayer2(id: string): void {
    this.db.prepare("UPDATE entries SET layer = 2 WHERE id = ? AND layer = 1").run(id);
  }

  /** Weaken an entry's confidence by a beta factor (0–1). */
  weakenEntry(id: string, beta = 0.3): void {
    weakenEntry(this.db, id, beta);
  }

  /**
   * Remove stale Layer 1 entries with effective confidence below 0.05
   * that have not been seen in 30+ days. Never prunes pinned or Layer 2 entries.
   */
  async prune(): Promise<number> {
    const now = Date.now();
    const minAgeMs = 30 * 86_400_000;
    const toDelete = getAllEntries(this.db).filter((e) => {
      if (e.pinned || e.layer === 2) return false;
      const ageMs = now - e.last_seen_at;
      if (ageMs <= minAgeMs) return false;
      return effectiveConfidence(e, now) < 0.05;
    });

    for (const entry of toDelete) {
      deleteEntry(this.db, entry.id);
    }
    return toDelete.length;
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

  private async buildDigest(ctx: SessionContext, minScore = 0.35): Promise<Digest> {
    const now = Date.now();
    const entries = this.getEntriesForScopeQueries(
      this.buildScopeQueries(this.defaultScopes),
    );

    // Score all entries — Layer 2 first, then digestScore within layer
    const scored = entries.map((e) => ({
      entry: e,
      score: digestScore(e, now) + (e.pinned ? 0.3 : 0),
    }));
    scored.sort((a, b) => {
      if (a.entry.layer !== b.entry.layer) return b.entry.layer - a.entry.layer;
      return b.score - a.score;
    });

    const filtered = scored.filter((s) => s.score >= minScore);

    // Build markdown
    const lines: string[] = [];
    const included: string[] = [];
    const kindOrder: MemoryKind[] = ["constraint", "preference", "fact", "pattern", "decision", "mistake"];

    for (const kind of kindOrder) {
      const bucket = filtered
        .filter((s) => s.entry.kind === kind)
        .sort((a, b) => b.score - a.score);
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

  private buildScopeQueries(scopes: string[]): string[][] {
    if (scopes.length === 0) return [scopes];

    const queries: string[][] = [scopes];
    const hasContextScope = scopes.some((scope) => scope.startsWith("context:"));
    if (!hasContextScope) return queries;

    const globalScopes = scopes.filter((scope) => !scope.startsWith("context:"));
    if (globalScopes.length === scopes.length || globalScopes.length === 0) {
      return queries;
    }

    queries.push(globalScopes);
    return queries;
  }

  private getEntriesForScopeQueries(scopeQueries: string[][]): MemoryEntry[] {
    const byId = new Map<string, MemoryEntry>();
    for (const scopes of scopeQueries) {
      const entries = scopes.length > 0
        ? getEntriesByScope(this.db, scopes)
        : getAllEntries(this.db);
      for (const entry of entries) {
        if (entry.retracted) continue;
        if (!this.entryMatchesScopeQuery(entry, scopes)) continue;
        if (!byId.has(entry.id)) byId.set(entry.id, entry);
      }
    }
    return Array.from(byId.values());
  }

  private entryMatchesScopeQuery(entry: MemoryEntry, scopes: string[]): boolean {
    const entryScopeSet = new Set(entry.scopes);
    for (const scope of scopes) {
      if (!entryScopeSet.has(scope)) return false;
    }

    const queryHasContext = scopes.some((scope) => scope.startsWith("context:"));
    if (!queryHasContext) {
      const entryHasContext = entry.scopes.some((scope) =>
        scope.startsWith("context:")
      );
      if (entryHasContext) return false;
    }

    return true;
  }

  retractMemory(id: string): void {
    retractMemoryDb(this.db, id);
  }

  hasEntry(id: string): boolean {
    return getEntryById(this.db, id) !== undefined;
  }
}
