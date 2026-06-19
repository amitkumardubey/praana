// ============================================================
// PRAANA Memory — Store
//
// Unified API: remember, recall, digest, pin, session lifecycle.
// ============================================================

import type Database from "better-sqlite3";
import { ulid } from "ulid";
import {
  clearReembedNeeded,
  countVectorEmbeddings,
  DEDUP_RECONCILED_KEY,
  endSessionRow,
  flushReinforcements,
  getAllEntries,
  getEntriesByScope,
  getEntryById,
  getEmbedding,
  getMemoryMeta,
  insertEntry,
  deleteEntry,
  isReembedPending,
  markReinforcementUsed,
  getSurfacedEntriesWithContent,
  mergeEntryMetadata,
  retractMemory as retractMemoryDb,
  openMemoryDb,
  reinforceEntry,
  searchByFts,
  searchByVector,
  setMemoryMeta,
  stampReinforcement,
  startSessionRow,
  touchEntry,
  upsertEmbedding,
  weakenEntry,
  incrementConfirmationCount,
} from "./db.js";
import { EMBEDDING_DIM } from "./embeddings.js";
import type { Embedder } from "./types.js";
import { extractLearnings, summarizeTurns, usedIdsByCooccurrence } from "./summarizer.js";
import {
  CONTRADICTION_MATCH_THRESHOLD,
  DUPLICATE_MATCH_THRESHOLD,
  isContradiction,
  isNearDuplicate,
  normalizeMemoryContent,
  scopeGroupKey,
  scopesEqual,
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
import { effectiveValidity, digestScore } from "./confidence.js";
import { getAppLogger, type PraanaLogger } from "../logger.js";
import { APP_AGENT_ID } from "../app-identity.js";

function certaintyToValidity(c: "high" | "medium" | "low"): number {
  return c === "high" ? 0.8 : c === "medium" ? 0.5 : 0.3;
}

/**
 * Derive a coarse session-success bit from the session-end reason and events.
 * TODO(scorecard): placeholder — replace with real telemetry signal (tests passed,
 * no error-loop, commit landed, etc.) once the scorecard (ADR-005 C1 / #99) exists.
 * Currently: reason is "normal" AND at least one tool returned ok = true.
 */
function isSessionGood(
  reason: string,
  events: Array<{ type: string; result?: unknown }> | undefined,
): boolean {
  if (reason !== "normal") return false;
  if (!events || events.length === 0) return true; // no events → assume good
  // NOTE: sessions with only user/agent messages (no tool calls) return false here,
  // meaning used entries get neutral rather than boosted usefulness. This is intentional
  // for the placeholder — a tool-free session gives no signal about memory utility.
  // TODO(scorecard): replace with real telemetry once ADR-005 C1 / #99 delivers a
  // reliable success signal that covers conversational sessions too.
  return events.some((e) => {
    if (e.type !== "tool_result") return false;
    if (e.result && typeof e.result === "object" && "ok" in e.result) {
      return (e.result as { ok: boolean }).ok === true;
    }
    return false;
  });
}

function queryTerms(query: string): string[] {
  return query.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function isAbortLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  return /\babort(ed)?\b/i.test(err.message);
}

const DEFAULT_RECALL_MIN_MATCH = 0.35;

export interface RememberResult {
  id: string;
  reinforced?: boolean;
}

export interface ReconcileDuplicatesResult {
  clustersMerged: number;
  entriesRemoved: number;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function lexicalMatchScore(
  entry: MemoryEntry,
  terms: string[],
  rankScore: number,
): number {
  if (terms.length === 0) return 0;

  const content = entry.content.toLowerCase();
  const matched = terms.filter((term) => content.includes(term)).length;
  if (matched === 0) return 0;

  const coverage = matched / terms.length;
  return 0.6 + coverage * 0.3 + rankScore * 0.1;
}

export class MemoryStore {
  private db: Database.Database;
  private embedder: Embedder | null;
  private summarizer: SummarizerLLM | null;
  private defaultScopes: string[] = [];
  private sessionId: string = "";
  /** True while a background re-embed migration is running. */
  private reembedding = false;
  private reembedPromise: Promise<void> | null = null;
  private readonly logger: PraanaLogger;

  constructor(opts: {
    dbPath: string;
    embedder: Embedder | null;
    summarizer?: SummarizerLLM | null;
    logger?: PraanaLogger;
    needsReembed?: boolean;
    embeddingBackend?: string;
  }) {
    const opened = openMemoryDb(
      opts.dbPath,
      opts.embedder?.dim ?? EMBEDDING_DIM,
      opts.embeddingBackend,
    );
    this.db = opened.db;
    this.embedder = opts.embedder;
    this.summarizer = opts.summarizer ?? null;
    this.logger = opts.logger ?? getAppLogger();
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

    const reconciled = await this.reconcileDuplicatesIfNeeded();
    if (reconciled.entriesRemoved > 0) {
      this.logger.child("memory").info(
        `Reconciled ${reconciled.clustersMerged} duplicate ${reconciled.clustersMerged === 1 ? "cluster" : "clusters"} (${reconciled.entriesRemoved} ${reconciled.entriesRemoved === 1 ? "entry" : "entries"} removed)`,
      );
    }

    const pruned = await this.prune();
    if (pruned > 0) {
      this.logger.child("memory").info(`Pruned ${pruned} stale Layer 1 ${pruned === 1 ? "entry" : "entries"}`);
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
    const now = Date.now();

    // Determine session-success bit for utility updates.
    // TODO(scorecard): placeholder — replace with real scorecard signal (ADR-005 C1 / #99).
    const sessionGood = isSessionGood(reason, events);

    // Fetch surfaced entries with content in one JOIN — no N+1 getEntryById calls.
    const surfacedWithContent = getSurfacedEntriesWithContent(this.db, this.sessionId);

    // Track whether learnings were already stored by the combined call below,
    // so we don't make a redundant second LLM call at session end.
    let learningsStored = false;

    if (surfacedWithContent.length > 0) {
      let usedIds: Set<string>;

      if (this.summarizer && events && events.length > 0) {
        try {
          // Single combined LLM call: returns both usedIds and learnings.
          // Storing learnings here avoids a second extractLearnings call below.
          const result = await extractLearnings(this.summarizer, events, surfacedWithContent);
          usedIds = result.usedIds;
          for (const l of result.learnings) {
            await this.storeLearning(l);
          }
          learningsStored = true;
        } catch {
          // Summarizer failed — fall back to co-occurrence for usedIds;
          // learningsStored stays false so the fallback call below runs.
          usedIds = usedIdsByCooccurrence(events, surfacedWithContent);
        }
      } else {
        usedIds = usedIdsByCooccurrence(events ?? [], surfacedWithContent);
      }

      // Mark used in pending_reinforcements before flush
      for (const { id } of surfacedWithContent) {
        markReinforcementUsed(
          this.db,
          id,
          this.sessionId,
          usedIds.has(id),
        );
      }

      // Stamp the session-good flag on all pending rows for this session
      if (sessionGood) {
        this.db
          .prepare(
            "UPDATE pending_reinforcements SET good = 1 WHERE session_id = ?",
          )
          .run(this.sessionId);
      }
    }

    // Flush: validity reinforcement + utility updates (two passes)
    flushReinforcements(this.db, this.sessionId);

    endSessionRow(this.db, this.sessionId, now, reason);

    // Extract learnings if not already stored by the combined call above.
    // Runs when: (a) no entries were surfaced, or (b) the combined call errored.
    if (!learningsStored && events && events.length > 0 && this.summarizer) {
      try {
        const result = await extractLearnings(this.summarizer, events);
        for (const l of result.learnings) {
          await this.storeLearning(l);
        }
      } catch (err) {
        if (isAbortLikeError(err)) {
          this.logger.child("memory").warn("Session-end summarizer aborted; skipping learnings for this session");
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
        this.logger.child("memory").warn("Turn compression aborted; skipping");
        return 0;
      }
      throw err;
    }
  }

  // ---- Core operations ----

  async remember(content: string, opts: RememberOptions = {}): Promise<RememberResult> {
    const kind = opts.kind ?? "fact";
    if (!isMemoryKind(kind)) {
      throw new Error(
        `Invalid memory kind: '${kind}'. Valid kinds: ${MEMORY_KINDS.join(", ")}`,
      );
    }
    const scopes = opts.scope ?? this.defaultScopes;
    const trimmed = content.slice(0, 1000);

    const duplicate = await this.findDuplicateEntry(trimmed, kind, scopes);
    if (duplicate) {
      reinforceEntry(this.db, duplicate.id, 0.08);
      incrementConfirmationCount(this.db, duplicate.id);
      return { id: duplicate.id, reinforced: true };
    }

    const id = ulid();
    const now = Date.now();
    const validity = certaintyToValidity(opts.certainty ?? "medium");

    const entry: MemoryEntry = {
      id,
      kind,
      content: trimmed,
      validity,
      usefulness: 0.5,  // M2: neutral initial utility
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

    if (this.embedder) {
      this.embedder.embed(trimmed).then((vec) => {
        upsertEmbedding(this.db, id, vec);
      }).catch(() => { /* embedder failure is non-fatal */ });
    }

    return { id };
  }

  private async findDuplicateEntry(
    content: string,
    kind: MemoryKind,
    scopes: string[],
  ): Promise<{ id: string } | null> {
    for (const entry of this.getScopedEntries(kind, scopes)) {
      if (normalizeMemoryContent(entry.content) === normalizeMemoryContent(content)) {
        return { id: entry.id };
      }
    }

    const similar = await this.recall(content, {
      limit: 5,
      kinds: [kind],
      scope: scopes,
      minMatch: 0,
    });

    for (const candidate of similar.entries) {
      const existing = getEntryById(this.db, candidate.id);
      if (!existing || existing.retracted) continue;
      if (!scopesEqual(existing.scopes, scopes)) continue;
      if (isNearDuplicate(existing.content, content, candidate.match)) {
        return { id: existing.id };
      }
    }

    return null;
  }

  private getScopedEntries(kind: MemoryKind, scopes: string[]): MemoryEntry[] {
    const entries = scopes.length > 0
      ? getEntriesByScope(this.db, scopes)
      : getAllEntries(this.db);
    return entries.filter(
      (entry) => !entry.retracted && entry.kind === kind && scopesEqual(entry.scopes, scopes),
    );
  }

  private entriesAreNearDuplicates(a: MemoryEntry, b: MemoryEntry): boolean {
    if (a.kind !== b.kind || !scopesEqual(a.scopes, b.scopes)) return false;
    if (normalizeMemoryContent(a.content) === normalizeMemoryContent(b.content)) {
      return true;
    }

    const vecA = getEmbedding(this.db, a.id);
    const vecB = getEmbedding(this.db, b.id);
    if (vecA && vecB) {
      return cosineSimilarity(vecA, vecB) >= DUPLICATE_MATCH_THRESHOLD;
    }

    return false;
  }

  private pickDuplicateKeeper(cluster: MemoryEntry[]): MemoryEntry {
    return [...cluster].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.validity !== a.validity) return b.validity - a.validity;
      return a.created_at - b.created_at;
    })[0];
  }

  async reconcileDuplicatesIfNeeded(): Promise<ReconcileDuplicatesResult> {
    if (getMemoryMeta(this.db, DEDUP_RECONCILED_KEY) === "1") {
      return { clustersMerged: 0, entriesRemoved: 0 };
    }
    const result = await this.reconcileDuplicates();
    setMemoryMeta(this.db, DEDUP_RECONCILED_KEY, "1");
    return result;
  }

  async reconcileDuplicates(): Promise<ReconcileDuplicatesResult> {
    await this.waitForReembed();

    const entries = getAllEntries(this.db).filter((entry) => !entry.retracted);
    const groups = new Map<string, MemoryEntry[]>();
    for (const entry of entries) {
      const key = `${entry.kind}:${scopeGroupKey(entry.scopes)}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(entry);
      groups.set(key, bucket);
    }

    let clustersMerged = 0;
    let entriesRemoved = 0;

    for (const group of groups.values()) {
      if (group.length < 2) continue;

      const parent = new Map<string, string>();
      const find = (id: string): string => {
        const root = parent.get(id) ?? id;
        if (root !== id) {
          const resolved = find(root);
          parent.set(id, resolved);
          return resolved;
        }
        parent.set(id, id);
        return id;
      };
      const union = (a: string, b: string): void => {
        const rootA = find(a);
        const rootB = find(b);
        if (rootA !== rootB) parent.set(rootB, rootA);
      };

      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          if (this.entriesAreNearDuplicates(group[i], group[j])) {
            union(group[i].id, group[j].id);
          }
        }
      }

      const clusters = new Map<string, MemoryEntry[]>();
      for (const entry of group) {
        const root = find(entry.id);
        const bucket = clusters.get(root) ?? [];
        bucket.push(entry);
        clusters.set(root, bucket);
      }

      for (const cluster of clusters.values()) {
        if (cluster.length < 2) continue;
        const keeper = this.pickDuplicateKeeper(cluster);
        for (const duplicate of cluster) {
          if (duplicate.id === keeper.id) continue;
          mergeEntryMetadata(this.db, keeper.id, duplicate);
          deleteEntry(this.db, duplicate.id);
          entriesRemoved++;
        }
        clustersMerged++;
      }
    }

    return { clustersMerged, entriesRemoved };
  }

  async getDigest(minScore = 0.35): Promise<Digest> {
    return this.buildDigest(
      {
        agent: APP_AGENT_ID,
        user_id: "",
        context_id: "",
        time: Date.now(),
        context_label: "",
      },
      minScore,
    );
  }

  private async storeLearning(learning: ExtractedLearning): Promise<void> {
    const similar = await this.recall(learning.content, {
      limit: 3,
      kinds: [learning.kind],
    });

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
    const minMatch = opts.minMatch ?? DEFAULT_RECALL_MIN_MATCH;
    const queryScopes = opts.scope ?? this.defaultScopes;
    const scopeQueries = this.buildScopeQueries(queryScopes);
    const now = Date.now();

    await this.waitForReembed();

    const entryCount = this.getEntryCount();
    let vectorCount = countVectorEmbeddings(this.db);

    if (this.embedder && entryCount > 0 && vectorCount === 0 && isReembedPending(this.db)) {
      if (!this.reembedding) {
        await this.reembedAllEntries();
        vectorCount = countVectorEmbeddings(this.db);
      }
      if (vectorCount === 0) {
        const log = this.logger.child("memory");
        log.warn(
          "Recall skipped — embedding migration incomplete (vector index empty). Restart after embedder config change or check logs for re-embed errors.",
        );
        return {
          entries: [],
          notice:
            "Embedding migration incomplete — memories exist but the vector index is empty. " +
            "Restart the session after changing embedder/model, or check logs for re-embed errors.",
        };
      }
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

    const ftsHits = scopeQueries.flatMap((scopes) =>
      searchByFts(this.db, query, limit * 4, {
        scopes,
        kinds: opts.kinds,
      }),
    );
    const ftsRanks = ftsHits.map((h) => h.rank);
    const bestFtsRank = ftsRanks.length > 0 ? Math.min(...ftsRanks) : 0;
    const worstFtsRank = ftsRanks.length > 0 ? Math.max(...ftsRanks) : 0;
    for (const h of ftsHits) {
      const e = getEntryById(this.db, h.entry_id);
      if (e) {
        const rankScore = bestFtsRank === worstFtsRank
          ? 1
          : 1 - ((h.rank - bestFtsRank) / (worstFtsRank - bestFtsRank));
        addCandidate(e, lexicalMatchScore(e, terms, rankScore));
      }
    }

    if (this.embedder) {
      try {
        const qvec = await this.embedder.embed(query);
        const hits = searchByVector(this.db, qvec, limit * 4);
        for (const h of hits) {
          const e = getEntryById(this.db, h.entry_id);
          if (e) {
            const similarity = Math.max(0, 1 - h.distance);
            const matchScore = Math.min(similarity, 0.75);
            if (matchScore >= minMatch) {
              addCandidate(e, matchScore);
            }
          }
        }
      } catch {
        // Vector search failed — fall back to FTS/empty results only
      }
    }

    // Do not dump all scoped entries when search finds nothing — that produces
    // misleading match: 0.00 results ranked only by confidence.

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

    // Score & rank
    // TODO(scorecard): M3 weight constants (W_VALID=0.20, W_UTIL=0.30) — start from these values;
    // they are A/B targets once the scorecard (ADR-005 C1 / #99) exists, not final.
    const scored = candidates.map(({ entry: e, matchScore }) => {
      const valid = effectiveValidity(e, now);
      const match = matchScore;
      // Recency bonus: 0–0.2 based on days since last seen (max at 0 days)
      const daysSince = (now - e.last_seen_at) / (1000 * 60 * 60 * 24);
      const recency = Math.max(0, 0.2 - daysSince * 0.02);
      // Pin bonus
      const pin = e.pinned ? 0.3 : 0;
      const score = matchScore + valid * 0.2 + recency + pin;
      return { entry: e, score, match, valid };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.valid - a.valid;
    });

    const relevant = scored.filter((s) => s.match >= minMatch);

    // Touch recalled entries
    const top = relevant.slice(0, limit);
    for (const s of top) {
      touchEntry(this.db, s.entry.id, now);
      stampReinforcement(this.db, s.entry.id, this.sessionId);
    }

    return {
      entries: top.map((s) => ({
        id: s.entry.id,
        kind: s.entry.kind,
        content: s.entry.content,
        validity: s.entry.validity,
        usefulness: s.entry.usefulness,
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

  /** Weaken an entry's validity by a beta factor (0–1). */
  weakenEntry(id: string, beta = 0.3): void {
    weakenEntry(this.db, id, beta);
  }

  /**
   * Remove stale Layer 1 entries with effective validity below 0.05
   * that have not been seen in 30+ days. Never prunes pinned or Layer 2 entries.
   */
  async prune(): Promise<number> {
    const now = Date.now();
    const minAgeMs = 30 * 86_400_000;
    const toDelete = getAllEntries(this.db).filter((e) => {
      if (e.pinned || e.layer === 2) return false;
      const ageMs = now - e.last_seen_at;
      if (ageMs <= minAgeMs) return false;
      return effectiveValidity(e, now) < 0.05;
    });

    for (const entry of toDelete) {
      deleteEntry(this.db, entry.id);
    }
    return toDelete.length;
  }

  /** Re-embed all entries after vector dimension migration. Runs in the background. */
  async reembedAllEntries(): Promise<void> {
    if (!this.embedder) return;

    this.reembedding = true;
    const entries = getAllEntries(this.db);
    const log = this.logger.child("memory");
    log.info(`Re-embedding ${entries.length} entries after dimension migration…`);
    let failed = 0;
    for (const e of entries) {
      try {
        const vec = await this.embedder.embed(e.content);
        upsertEmbedding(this.db, e.id, vec);
      } catch (err) {
        failed++;
        log.warn(`Failed to re-embed entry ${e.id}`, {
          cause: err instanceof Error ? err : new Error(String(err)),
        });
      }
    }
    this.reembedding = false;
    if (failed > 0) {
      log.warn(
        `Re-embed migration complete — ${failed}/${entries.length} entries failed. Recall quality may be degraded`,
      );
    } else {
      clearReembedNeeded(this.db);
      log.info(`Re-embed migration complete — ${entries.length} entries updated`);
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
