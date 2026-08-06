import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createDefaultDistillerRegistry, inferContentTypeFromTool } from "../domain/coding-domain.js";
import { classifyContentType } from "./classify.js";
import { buildPendingSummary } from "./distiller.js";
import type { DistillerRegistry, DistillDeferredResult, DistillResult } from "./distiller.js";
import {
  evictStaleArtifacts,
  findArtifactByHash,
  findFileReadArtifactByCommand,
  getArtifactById,
  insertArtifact,
  insertDistillerStat,
  listHighValueArtifacts,
  listSessionArtifacts,
  openContextEngineDb,
  touchArtifactAccess,
  updateArtifactSummary,
} from "./db.js";
import {
  buildArtifactCard,
  estimateTokens,
} from "./summarize.js";
import type { ContextEngineConfig } from "../types.js";
import type {
  ContentType,
  ContextArtifact,
  IngestToolResultInput,
  IngestToolResultOutput,
  RetrieveArtifactOptions,
} from "./types.js";

function artifactIdFromHash(sessionId: string, contentHash: string): string {
  // Bind the id to the session so identical content read in different sessions
  // mints distinct rows — the context_artifacts table is a shared global DB
  // keyed only by session_id, so a content-only id would collide on the
  // primary key and the dedup path could hand back an artifact owned by
  // another session (breaking retrieve_artifact).
  const bound = sha256(`${sessionId}:${contentHash}`);
  return `art_${bound.slice(0, 12)}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sliceByLines(text: string, lineStart?: number, lineEnd?: number): string {
  const lines = text.split("\n");
  const start = Math.max(1, lineStart ?? 1);
  if (start > lines.length) {
    throw new Error(`lineStart ${start} exceeds content line count ${lines.length}`);
  }
  const end = Math.min(lines.length, lineEnd ?? lines.length);
  if (start > end) return "";
  return lines.slice(start - 1, end).join("\n");
}

function extractJsonPath(text: string, jsonPath: string): string {
  const parsed = JSON.parse(text) as unknown;
  const parts = jsonPath.split(".").filter(Boolean);
  let current: unknown = parsed;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      throw new Error(`Invalid jsonPath segment: ${part}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current === "string") return current;
  return JSON.stringify(current, null, 2);
}

function savingsPct(inputTokens: number, outputTokens: number): number {
  if (inputTokens <= 0) return 0;
  return Math.max(0, (1 - outputTokens / inputTokens) * 100);
}


interface PendingBackfill {
  artifactId: string;
  backfill: () => Promise<DistillResult>;
  sourceTool: string;
  contentType: ContentType;
  inputTokens: number;
  turn: number;
}

export class ArtifactStore {
  private readonly db: Database;
  private readonly sessionId: string;
  private readonly config: ContextEngineConfig;
  private readonly distillers: DistillerRegistry;
  private readonly fileReadIndex = new Map<string, string>();
  private readonly pendingBackfills: PendingBackfill[] = [];

  constructor(
    db: Database,
    sessionId: string,
    config: ContextEngineConfig,
    distillers: DistillerRegistry,
  ) {
    this.db = db;
    this.sessionId = sessionId;
    this.config = config;
    this.distillers = distillers;
    this.rebuildFileReadIndex();
  }

  /** Rebuild abs-path+range → artifact id map from persisted session artifacts (resume). */
  private rebuildFileReadIndex(): void {
    this.fileReadIndex.clear();
    for (const art of listSessionArtifacts(this.db, this.sessionId)) {
      if (art.sourceTool !== "read_file" || !art.command) continue;
      // Use the stored request key if available (includes unbounded sentinel),
      // otherwise fall back to computing from source line range.
      if (art.requestKey) {
        this.fileReadIndex.set(art.requestKey, art.id);
      } else {
        const start = art.sourceLineStart ?? 1;
        const end = art.sourceLineEnd ?? start;
        const requestKey = art.command + "#" + start + "#" + end;
        this.fileReadIndex.set(requestKey, art.id);
      }
    }
  }

  static open(
    dbPath: string,
    sessionId: string,
    config: ContextEngineConfig,
    distillers: DistillerRegistry = createDefaultDistillerRegistry(),
  ): ArtifactStore {
    const db = openContextEngineDb(dbPath);
    return new ArtifactStore(db, sessionId, config, distillers);
  }

  close(): void {
    this.db.close();
  }

  getDb(): Database {
    return this.db;
  }

  runEviction(currentTurn: number): number {
    return evictStaleArtifacts(
      this.db,
      currentTurn,
      this.config.artifact_ttl_turns,
    );
  }

  async flushDeferredDistillation(): Promise<number> {
    const jobs = this.pendingBackfills.splice(0);
    for (const job of jobs) {
      let result: DistillResult;
      try {
        result = await job.backfill();
      } catch (err) {
        result = {
          summary: `[compression failed: ${(err as Error).message ?? "unknown error"}]\n${buildPendingSummary()}`,
          distillerName: "failed-deferred",
          execTimeMs: 0,
          deferred: true,
        };
      }
      updateArtifactSummary(this.db, job.artifactId, result.summary);
      if (result.summary) {
        this.recordDistillerStat({
          sourceTool: job.sourceTool,
          contentType: job.contentType,
          distiller: result.distillerName,
          inputTokens: job.inputTokens,
          outputTokens: estimateTokens(result.summary),
          execTimeMs: Math.round(result.execTimeMs),
          turn: job.turn,
        });
      }
    }
    return jobs.length;
  }

  ingestToolResult(input: IngestToolResultInput): IngestToolResultOutput {
    const contentType =
      input.contentType ??
      inferContentTypeFromTool(input.sourceTool, input.command) ??
      classifyContentType(input.rawText);
    const rawTokens = estimateTokens(input.rawText);
    const inlineThreshold = this.config.artifact_inline_threshold;

    // Defensive guard: never persist a retrieve_artifact transport envelope as a
    // source artifact. If a retrieval result is mis-routed here, extract the inner
    // content and return it inline so we cannot create a nested artifact chain.
    if (input.sourceTool === "retrieve_artifact" && input.rawText.startsWith("{")) {
      try {
        const parsed = JSON.parse(input.rawText) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed as { ok?: unknown }).ok === true &&
          typeof (parsed as { id?: unknown }).id === "string" &&
          typeof (parsed as { content?: unknown }).content === "string"
        ) {
          return { promptText: (parsed as { content: string }).content, inlined: true };
        }
      } catch {
        // Not a valid envelope; fall through to normal ingestion.
      }
    }

    if (contentType === "error" || (rawTokens <= inlineThreshold && input.sourceTool !== "read_file")) {
      return { promptText: input.rawText, inlined: true };
    }

    // For read_file, always store as lossless with line range metadata
    const isReadFile = input.sourceTool === "read_file";
    const sourceLineStart: number | undefined = isReadFile ? (input.sourceLineStart ?? 1) : undefined;
    const sourceLineCount = input.rawText === "" ? 0 : input.rawText.split("\n").length;
    const sourceLineEnd: number | undefined = isReadFile
      ? (input.sourceLineEnd ?? (sourceLineStart! + Math.max(0, sourceLineCount - 1)))
      : undefined;

    const hash = sha256(input.rawText);

    // For read_file, each distinct request is a separate lossless artifact.
    // Cache key uses the REQUESTED range (not actual returned range) so that
    // repeats of the same request hit the cache even at EOF.
    // Unbounded requests use end=0 as sentinel and never match bounded artifacts.
    if (isReadFile && input.command) {
      const reqStart = input.requestStart ?? sourceLineStart ?? 1;
      const reqEnd = input.requestUnbounded ? 0 : (input.requestEnd ?? sourceLineEnd ?? sourceLineStart!);
      const cacheKey = this.requestKey(input.command, reqStart, reqEnd);
      const existingId = this.fileReadIndex.get(cacheKey);
      if (existingId) {
        const existing = getArtifactById(this.db, existingId);
        if (existing && existing.sha256 === hash) {
          touchArtifactAccess(this.db, existing.id, input.createdTurn);
          return {
            promptText: buildArtifactCard(
              existing.id,
              existing.sourceTool,
              existing.command,
              existing.rawTokens,
            ),
            artifactId: existing.id,
            inlined: false,
          };
        }
      }
    }

    // For non-read_file tools, deduplicate by content hash (and store under path key).
    // read_file uses range-keyed storage with no content dedup (provenance matters).
    const dedupKey = isReadFile ? null : this.fileReadKey(input.sourceTool, input.command);

    const intensity = this.distillers.selectIntensity(
      rawTokens,
      this.config.distiller.default_intensity,
    );
    const distilled = this.distillers.distillForIngestion(
      input.rawText,
      contentType,
      intensity,
    );

    let summary: string;
    if ("backfill" in distilled) {
      const deferred = distilled as DistillDeferredResult;
      summary = deferred.pendingSummary;
      const artifactId = artifactIdFromHash(this.sessionId, hash);
      this.pendingBackfills.push({
        artifactId,
        backfill: deferred.backfill,
        sourceTool: input.sourceTool,
        contentType,
        inputTokens: rawTokens,
        turn: input.createdTurn,
      });
    } else {
      const sync = distilled as DistillResult;
      summary = sync.summary;
      if (summary) {
        this.recordDistillerStat({
          sourceTool: input.sourceTool,
          contentType,
          distiller: sync.distillerName,
          inputTokens: rawTokens,
          outputTokens: estimateTokens(sync.summary),
          execTimeMs: Math.round(sync.execTimeMs),
          turn: input.createdTurn,
        });
      }
    }

    // For non-read_file tools only: content-hash deduplication.
    // Different reads with same content should return the same artifact.
    // read_file is handled separately above (range-keyed, no content dedup).
    if (!isReadFile) {
      const deduped = findArtifactByHash(this.db, hash, this.sessionId);
      if (deduped) {
        touchArtifactAccess(this.db, deduped.id, input.createdTurn);
        if (dedupKey) this.fileReadIndex.set(dedupKey, deduped.id);
        return {
          promptText: buildArtifactCard(
            deduped.id,
            deduped.sourceTool,
            deduped.command ?? input.command,
            deduped.rawTokens,
          ),
          artifactId: deduped.id,
          inlined: false,
        };
      }
    }

    // Compute the artifact ID. For read_file, include the request key to avoid
    // ID collisions when distinct ranges happen to contain identical content.
    const artifactId = isReadFile && input.command
      ? this.readFileArtifactId(
          hash,
          input.command,
          input.requestStart ?? sourceLineStart ?? 1,
          input.requestUnbounded ? 0 : (input.requestEnd ?? sourceLineEnd ?? sourceLineStart!),
          input.requestUnbounded ?? false,
        )
      : artifactIdFromHash(this.sessionId, hash);

    const artifact: ContextArtifact = {
      id: artifactId,
      sha256: hash,
      sessionId: this.sessionId,
      sourceTool: input.sourceTool,
      command: input.command,
      createdTurn: input.createdTurn,
      rawTokens,
      rawText: input.rawText,
      summary,
      contentType,
      lastAccessedTurn: input.createdTurn,
      accessCount: 0,
      fidelity: isReadFile ? "lossless" : "summarizable",
      sourceLineStart,
      sourceLineEnd,
      promptTokens: 0,
      retentionReason: isReadFile ? "session-source" : "ttl",
    };

    // For read_file, store the request key and unbounded flag for cache lookups.
    if (isReadFile && input.command) {
      const reqStart = input.requestStart ?? sourceLineStart ?? 1;
      const reqEnd = input.requestUnbounded ? 0 : (input.requestEnd ?? sourceLineEnd ?? sourceLineStart!);
      const cacheKey = this.requestKey(input.command, reqStart, reqEnd);
      artifact.requestKey = cacheKey;
      artifact.requestUnbounded = input.requestUnbounded ?? false;
    }

    const card = buildArtifactCard(
      artifact.id,
      artifact.sourceTool,
      artifact.command,
      artifact.rawTokens,
    );
    artifact.promptTokens = estimateTokens(card);

    insertArtifact(this.db, artifact);

    // Index: read_file uses request key; other tools use (tool, command).
    if (isReadFile && input.command) {
      const reqStart = input.requestStart ?? sourceLineStart ?? 1;
      const reqEnd = input.requestUnbounded ? 0 : (input.requestEnd ?? sourceLineEnd ?? sourceLineStart!);
      const cacheKey = this.requestKey(input.command, reqStart, reqEnd);
      this.fileReadIndex.set(cacheKey, artifact.id);
    } else if (dedupKey) {
      this.fileReadIndex.set(dedupKey, artifact.id);
    }

    return {
      promptText: card,
      artifactId: artifact.id,
      inlined: false,
    };
  }

  retrieve(
    id: string,
    currentTurn: number,
    options?: RetrieveArtifactOptions,
  ): { ok: true; content: string } | { ok: false; error: string } {
    const artifact = getArtifactById(this.db, id);
    if (!artifact) {
      return { ok: false, error: `Artifact ${id} not found` };
    }
    if (artifact.sessionId !== this.sessionId) {
      return { ok: false, error: `Artifact ${id} belongs to another session` };
    }

    touchArtifactAccess(this.db, id, currentTurn);

    let content = artifact.rawText;
    try {
      // For lossless source artifacts with stored line range, map file-relative
      // line requests to content-relative indices.
      if (artifact.sourceLineStart !== undefined && artifact.sourceLineEnd !== undefined) {
        const fileStart = artifact.sourceLineStart;
        const fileEnd = artifact.sourceLineEnd;
        if (options?.lineStart !== undefined || options?.lineEnd !== undefined) {
          const reqStart = options.lineStart ?? 1;
          const reqEnd = options.lineEnd ?? fileEnd;
          if (reqStart < fileStart || reqEnd > fileEnd || reqStart > reqEnd) {
            return {
              ok: false,
              error: `Requested lines ${reqStart}-${reqEnd} fall outside stored range ${fileStart}-${fileEnd}. Re-read the file to extend the range.`,
            };
          }
          const relStart = reqStart - fileStart + 1;
          const relEnd = reqEnd - fileStart + 1;
          content = sliceByLines(content, relStart, relEnd);
        }
      } else if (options?.lineStart !== undefined || options?.lineEnd !== undefined) {
        content = sliceByLines(content, options.lineStart, options.lineEnd);
      }
      // jsonPath requires full content or post-slice content; apply after line slicing.
      // Note: jsonPath on file reads should use retrieve_artifact with lineStart/end first,
      // then jsonPath on the sliced result, or re-read a larger range.
      if (options?.jsonPath) {
        content = extractJsonPath(content, options.jsonPath);
      }
      if (options?.grep) {
        const re = new RegExp(options.grep, "m");
        const matched = content.split("\n").filter((line) => re.test(line));
        content = matched.join("\n");
      }
    } catch (err) {
      return {
        ok: false,
        error: (err as Error).message ?? "Failed to slice artifact content",
      };
    }

    return { ok: true, content };
  }

  getArtifact(id: string): ContextArtifact | null {
    const artifact = getArtifactById(this.db, id);
    if (!artifact || artifact.sessionId !== this.sessionId) return null;
    return artifact;
  }

  /** Enumerate read_file artifacts for this session, most recent first. */
  listFileReads(): { absPath: string; artifactId: string; createdTurn: number }[] {
    const reads = listSessionArtifacts(this.db, this.sessionId)
      .filter((art) => art.sourceTool === "read_file" && art.command)
      .map((art) => ({
        absPath: art.command!,
        artifactId: art.id,
        createdTurn: art.createdTurn,
      }));
    reads.sort((a, b) => b.createdTurn - a.createdTurn);
    return reads;
  }

  /** Look up a prior read_file artifact by absolute path (session-scoped). */
  findFileReadArtifact(absPath: string): ContextArtifact | null {
    const id = this.fileReadIndex.get(absPath);
    if (id) {
      const cached = this.getArtifact(id);
      if (cached) return cached;
    }
    // Index miss or stale id — fall back to DB (e.g. resume before rebuild, or eviction).
    const fromDb = findFileReadArtifactByCommand(this.db, this.sessionId, absPath);
    if (fromDb) {
      this.fileReadIndex.set(absPath, fromDb.id);
      return fromDb;
    }
    return null;
  }

  /** Drop path from the file-read index after a write/edit invalidates it. */
  clearFileRead(absPath: string): void {
    this.fileReadIndex.delete(absPath);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  countArtifacts(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM context_artifacts WHERE session_id = ?")
      .get(this.sessionId) as { count: number };
    return row.count;
  }

  touchAccess(id: string, currentTurn: number): void {
    touchArtifactAccess(this.db, id, currentTurn);
  }

  /**
   * M4 artifact promotion: return artifacts from this session that were
   * accessed at least `minAccessCount` times. These are the ones an agent
   * had to revisit to get its job done — the kind of "high-value artifact"
   * the spec (build-spec §4 / decisions/003 Finding #14) flags as worth
   * promoting to Cognitive Memory.
   *
   * Caller is responsible for the actual promotion (calling
   * MemoryStore.remember with a project scope). Keeping ArtifactStore
   * decoupled from MemoryStore preserves the boundary between per-session
   * context and Cognitive Memory.
   */
  listHighValueArtifacts(minAccessCount: number): ContextArtifact[] {
    return listHighValueArtifacts(this.db, this.sessionId, minAccessCount);
  }

  private recordDistillerStat(input: {
    sourceTool: string;
    contentType: ContentType;
    distiller: string;
    inputTokens: number;
    outputTokens: number;
    execTimeMs: number;
    turn: number;
  }): void {
    insertDistillerStat(this.db, {
      sessionId: this.sessionId,
      tool: input.sourceTool,
      contentType: input.contentType,
      distiller: input.distiller,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      savingsPct: savingsPct(input.inputTokens, input.outputTokens),
      execTimeMs: input.execTimeMs,
      turn: input.turn,
    });
  }

  private fileReadKey(sourceTool: string, command?: string): string | null {
    if (sourceTool !== "read_file" || !command) return null;
    return command;
  }

  /**
   * Compute a unique artifact ID for a read_file operation.
   * Includes the request key so distinct ranges with identical content
   * get distinct rows (avoiding UNIQUE constraint collisions).
   */
  private readFileArtifactId(
    contentHash: string,
    absPath: string,
    reqStart: number,
    reqEnd: number,
    unbounded: boolean,
  ): string {
    const bound = sha256(`${this.sessionId}:${contentHash}:${absPath}:${reqStart}:${reqEnd}:${unbounded ? 1 : 0}`);
    return `art_${bound.slice(0, 12)}`;
  }

  /** Compute request key for a read_file operation (path + line range). */
  private requestKey(absPath: string, start: number, end: number): string {
    return `${absPath}#${start}#${end}`;
  }

  /** Find an artifact for a specific read_file range; null if no matching range. */
  findFileReadArtifactByRange(
    absPath: string,
    offset?: number,
    limit?: number,
  ): ContextArtifact | null {
    const start = offset ?? 1;
    const unbounded = limit === undefined;
    const end = unbounded ? 0 : start + limit - 1;
    const key = this.requestKey(absPath, start, end);
    const id = this.fileReadIndex.get(key);
    if (id) {
      const art = this.getArtifact(id);
      if (art) return art;
    }
    return null;
  }

  /** Clear all range keys for a path (used after write operations). */
  clearFileReadAllRanges(absPath: string): void {
    for (const key of this.fileReadIndex.keys()) {
      if (key.startsWith(absPath + "#")) {
        this.fileReadIndex.delete(key);
      }
    }
  }
}
