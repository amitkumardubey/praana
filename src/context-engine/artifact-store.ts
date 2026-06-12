import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { createDefaultDistillerRegistry } from "../distillers/index.js";
import { classifyContentType } from "./classify.js";
import type { DistillerRegistry, DistillDeferredResult, DistillResult } from "./distiller.js";
import {
  evictStaleArtifacts,
  findArtifactByHash,
  getArtifactById,
  insertArtifact,
  insertDistillerStat,
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

function artifactIdFromHash(sha256: string): string {
  return `art_${sha256.slice(0, 12)}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sliceByLines(text: string, lineStart?: number, lineEnd?: number): string {
  const lines = text.split("\n");
  const start = Math.max(1, lineStart ?? 1);
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
  private readonly db: Database.Database;
  private readonly sessionId: string;
  private readonly config: ContextEngineConfig;
  private readonly distillers: DistillerRegistry;
  private readonly fileReadIndex = new Map<string, string>();
  private readonly pendingBackfills: PendingBackfill[] = [];

  constructor(
    db: Database.Database,
    sessionId: string,
    config: ContextEngineConfig,
    distillers: DistillerRegistry,
  ) {
    this.db = db;
    this.sessionId = sessionId;
    this.config = config;
    this.distillers = distillers;
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

  getDb(): Database.Database {
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
      const result = await job.backfill();
      updateArtifactSummary(this.db, job.artifactId, result.summary);
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
    return jobs.length;
  }

  ingestToolResult(input: IngestToolResultInput): IngestToolResultOutput {
    const contentType = input.contentType ?? classifyContentType(input.rawText);
    const rawTokens = estimateTokens(input.rawText);
    const inlineThreshold = this.config.artifact_inline_threshold;

    if (contentType === "error" || rawTokens <= inlineThreshold) {
      return { promptText: input.rawText, inlined: true };
    }

    const fileKey = this.fileReadKey(input.sourceTool, input.command);
    if (fileKey) {
      const existingId = this.fileReadIndex.get(fileKey);
      if (existingId) {
        const existing = getArtifactById(this.db, existingId);
        if (existing) {
          touchArtifactAccess(this.db, existing.id, input.createdTurn);
          return {
            promptText: buildArtifactCard(
              existing.id,
              existing.sourceTool,
              existing.command,
              existing.rawTokens,
              existing.summary,
            ),
            artifactId: existing.id,
            inlined: false,
          };
        }
      }
    }

    const hash = sha256(input.rawText);
    const deduped = findArtifactByHash(this.db, hash);
    if (deduped) {
      touchArtifactAccess(this.db, deduped.id, input.createdTurn);
      if (fileKey) this.fileReadIndex.set(fileKey, deduped.id);
      return {
        promptText: buildArtifactCard(
          deduped.id,
          deduped.sourceTool,
          deduped.command ?? input.command,
          deduped.rawTokens,
          deduped.summary,
        ),
        artifactId: deduped.id,
        inlined: false,
      };
    }

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
      const artifactId = artifactIdFromHash(hash);
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

    const artifact: ContextArtifact = {
      id: artifactIdFromHash(hash),
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
    };

    insertArtifact(this.db, artifact);
    if (fileKey) this.fileReadIndex.set(fileKey, artifact.id);

    return {
      promptText: buildArtifactCard(
        artifact.id,
        artifact.sourceTool,
        artifact.command,
        artifact.rawTokens,
        artifact.summary,
      ),
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
      if (options?.jsonPath) {
        content = extractJsonPath(content, options.jsonPath);
      }
      if (options?.lineStart !== undefined || options?.lineEnd !== undefined) {
        content = sliceByLines(content, options.lineStart, options.lineEnd);
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
}
