import {
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  readFileSync,
  existsSync,
  renameSync,
  statSync,
  unlinkSync,
  appendFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ulid } from "ulid";
import type { Event, EventActor, EventKind } from "./types.js";

export interface EventSearchOptions {
  kinds?: EventKind[];
  limit?: number;
  /** When true, only search events after the most recent reset_boundary. */
  afterResetBoundary?: boolean;
}

export interface EventSearchMatch {
  event: Event;
  excerpt: string;
}

export const EVENT_LOG_FILENAME = "events.jsonl";
export const LEGACY_EVENT_LOG_FILENAME = "events.log";

export function getEventLogPath(sessionDir: string): string {
  return join(sessionDir, EVENT_LOG_FILENAME);
}

export function getLegacyEventLogPath(sessionDir: string): string {
  return join(sessionDir, LEGACY_EVENT_LOG_FILENAME);
}

/** Rename or merge legacy events.log into events.jsonl when opening a session. */
export function migrateLegacyEventLog(sessionDir: string): void {
  const jsonlPath = getEventLogPath(sessionDir);
  const legacyPath = getLegacyEventLogPath(sessionDir);

  if (!existsSync(legacyPath)) return;

  if (!existsSync(jsonlPath)) {
    renameSync(legacyPath, jsonlPath);
    return;
  }

  const legacySize = statSync(legacyPath).size;
  if (legacySize === 0) {
    unlinkSync(legacyPath);
    return;
  }

  const jsonlSize = statSync(jsonlPath).size;
  if (jsonlSize === 0) {
    unlinkSync(jsonlPath);
    renameSync(legacyPath, jsonlPath);
    return;
  }

  const legacyContent = readFileSync(legacyPath, "utf-8");
  if (legacyContent.trim()) {
    // Ensure events.jsonl ends with newline before appending
    const jsonlContent = readFileSync(jsonlPath, "utf-8");
    const prefix = jsonlContent.endsWith("\n") ? "" : "\n";
    const suffix = legacyContent.endsWith("\n") ? legacyContent : legacyContent + "\n";
    appendFileSync(jsonlPath, prefix + suffix);
  }
  unlinkSync(legacyPath);
}

export class EventLog {
  private fd: number;
  private logPath: string;
  private checkpointPath: string;
  private sessionId: string;
  private eventCount = 0;
  private closed = false;
  private compressedIds: Set<string> = new Set();
  private eventCache: Event[] | null = null;
  private lastMtimeMs = 0;
  private lastSize = 0;

  constructor(sessionId: string, logDir: string) {
    this.sessionId = sessionId;
    const sessionDir = join(logDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    migrateLegacyEventLog(sessionDir);
    this.logPath = getEventLogPath(sessionDir);
    this.checkpointPath = join(sessionDir, "compression_checkpoint.json");
    this.fd = openSync(this.logPath, "a");
    this.loadCompressionCheckpoint();
  }

  private syncCache(): void {
    let stats;
    try {
      stats = statSync(this.logPath);
    } catch {
      this.eventCache = [];
      this.lastMtimeMs = 0;
      this.lastSize = 0;
      return;
    }

    if (
      this.eventCache !== null &&
      stats.mtimeMs === this.lastMtimeMs &&
      stats.size === this.lastSize
    ) {
      return;
    }

    try {
      const content = readFileSync(this.logPath, "utf-8");
      this.eventCache = content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event);
    } catch {
      this.eventCache = [];
    }

    this.lastMtimeMs = stats.mtimeMs;
    this.lastSize = stats.size;
  }

  private loadCompressionCheckpoint(): void {
    try {
      if (existsSync(this.checkpointPath)) {
        const data = JSON.parse(readFileSync(this.checkpointPath, "utf-8"));
        if (Array.isArray(data.compressed_ids)) {
          this.compressedIds = new Set(data.compressed_ids);
        }
      }
    } catch { /* ignore corrupted checkpoint */ }
  }

  append(event: {
    kind: EventKind;
    actor: EventActor;
    payload: Record<string, unknown>;
    event_id?: string;
    timestamp?: number;
  }): void {
    // Hydrate the cache from disk BEFORE writing, so the new event is not
    // double-counted. If syncCache() ran after writeSync it would read the file
    // (which already contains the new line) and then the push below would add it
    // a second time. Calling it first also prevents silently losing prior events
    // when append() is invoked before any read on a non-empty log file.
    if (this.eventCache === null) {
      this.syncCache();
    }

    const fullEvent: Event = {
      event_id: event.event_id ?? ulid(),
      session_id: this.sessionId,
      timestamp: event.timestamp ?? Date.now(),
      kind: event.kind,
      actor: event.actor,
      payload: event.payload,
    };
    const line = JSON.stringify(fullEvent) + "\n";
    writeSync(this.fd, line, undefined, "utf-8");
    fsyncSync(this.fd);

    this.eventCache!.push(fullEvent);

    // Record the real file stats so the next read does not need to re-sync.
    const stats = statSync(this.logPath);
    this.lastMtimeMs = stats.mtimeMs;
    this.lastSize = stats.size;
    this.eventCount++;
  }

  readLast(n: number): Event[] {
    return this.internalRead().slice(-n);
  }

  readAll(): Event[] {
    return this.internalRead();
  }

  /** Last event in the log without allocating a full copy. O(1) with warm cache. */
  getLastEvent(): Event | null {
    this.syncCache();
    if (!this.eventCache || this.eventCache.length === 0) return null;
    return this.eventCache[this.eventCache.length - 1];
  }

  /** All events excluding those marked compressed for prompt assembly. */
  readAllUncompressed(): Event[] {
    const all = this.internalRead();
    if (this.compressedIds.size === 0) return all;
    return all.filter((e) => !this.compressedIds.has(e.event_id));
  }

  /** All events after the most recent reset_boundary system note. */
  readAllAfterResetBoundary(): Event[] {
    return eventsAfterResetBoundary(this.internalRead());
  }

  /** Uncompressed events after the most recent reset_boundary system note. */
  readAllUncompressedAfterResetBoundary(): Event[] {
    const all = this.readAllAfterResetBoundary();
    if (this.compressedIds.size === 0) return all;
    return all.filter((e) => !this.compressedIds.has(e.event_id));
  }

  /** Last n events after the most recent reset_boundary system note. */
  readLastUncompressedAfterResetBoundary(n: number): Event[] {
    return this.readAllUncompressedAfterResetBoundary().slice(-n);
  }

  replayContextActions(): Event[] {
    return this.internalRead().filter((e) => e.kind === "context_action");
  }

  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Search all events in this session. Terms are ANDed (case-insensitive).
   * Use pipe (|) in query for OR alternatives, e.g. "issue|review".
   */
  search(query: string, options: EventSearchOptions = {}): EventSearchMatch[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const terms = trimmed.includes("|")
      ? trimmed.split("|").map((t) => t.trim().toLowerCase()).filter(Boolean)
      : trimmed.toLowerCase().split(/\s+/).filter(Boolean);

    const kindSet = options.kinds ? new Set(options.kinds) : null;
    const limit = options.limit ?? 20;

    const source = options.afterResetBoundary
      ? eventsAfterResetBoundary(this.internalRead())
      : this.internalRead();

    const matches: EventSearchMatch[] = [];
    for (const event of source) {
      if (kindSet && !kindSet.has(event.kind)) continue;
      const text = eventSearchText(event).toLowerCase();
      const matched =
        trimmed.includes("|")
          ? terms.some((term) => text.includes(term))
          : terms.every((term) => text.includes(term));
      if (!matched) continue;
      matches.push({ event, excerpt: buildExcerpt(event, 400) });
      if (matches.length >= limit) break;
    }
    return matches;
  }

  private internalRead(): Event[] {
    this.syncCache();
    // Return a shallow copy so callers cannot mutate the internal cache.
    // Previously internalRead() always built a fresh array via split/filter/map;
    // this preserves that behaviour with the new cache-backed path.
    return this.eventCache ? [...this.eventCache] : [];
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Append a reset_boundary system note marking the boundary after which context is hidden. */
  logResetBoundary(command: string, reason?: string): void {
    this.append({
      kind: "system_note",
      actor: "kernel",
      payload: {
        type: RESET_BOUNDARY_TYPE,
        command,
        ...(reason ? { reason } : {}),
      },
    });
  }

  /** Mark event IDs as compressed — they will be excluded from readLastUncompressed. */
  markEventsAsCompressed(eventIds: string[]): void {
    for (const id of eventIds) {
      this.compressedIds.add(id);
    }
    const data = { compressed_ids: Array.from(this.compressedIds), timestamp: Date.now() };
    writeFileSync(this.checkpointPath, JSON.stringify(data) + "\n", "utf-8");
  }

  /** Read last n events, excluding compressed ones. */
  readLastUncompressed(n: number): Event[] {
    const all = this.internalRead();
    if (this.compressedIds.size === 0) return all.slice(-n);
    const uncompressed = all.filter((e) => !this.compressedIds.has(e.event_id));
    return uncompressed.slice(-n);
  }

  /** Get the number of compressed events. */
  getCompressedCount(): number {
    return this.compressedIds.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

// ---- Session meta helpers ----

import { writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { SessionMeta } from "./types.js";

export function writeSessionMeta(logDir: string, meta: SessionMeta): void {
  const sessionDir = pathJoin(logDir, meta.session_id);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(pathJoin(sessionDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

export const RESET_BOUNDARY_TYPE = "reset_boundary";

export function isResetBoundaryEvent(event: Event): boolean {
  return (
    event.kind === "system_note" && event.payload.type === RESET_BOUNDARY_TYPE
  );
}

/** Index of the most recent reset_boundary system note in the event list, or -1. */
export function findLastResetBoundaryIndex(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (isResetBoundaryEvent(events[i])) return i;
  }
  return -1;
}

/** Return events after the most recent reset_boundary, or all events if none. */
export function eventsAfterResetBoundary(events: Event[]): Event[] {
  const idx = findLastResetBoundaryIndex(events);
  return idx < 0 ? events : events.slice(idx + 1);
}

/**
 * Return the turn number of the last turn before the most recent reset_boundary.
 * Turns are counted by user_message events. Returns -1 if there is no boundary
 * (meaning all turns are visible).
 */
export function findLastResetBoundaryTurn(events: Event[]): number {
  const idx = findLastResetBoundaryIndex(events);
  if (idx < 0) return -1;
  let userMessagesBefore = 0;
  for (let i = 0; i < idx; i++) {
    if (events[i].kind === "user_message") userMessagesBefore++;
  }
  return Math.max(-1, userMessagesBefore - 1);
}

function eventSearchText(event: Event): string {
  const p = event.payload;
  switch (event.kind) {
    case "user_message":
    case "agent_message":
      return String(p.text ?? "");
    case "tool_call":
      return `${String(p.tool ?? "")} ${JSON.stringify(p.args ?? {})}`;
    case "tool_result":
      return `${String(p.tool ?? "")} ${JSON.stringify(p.result ?? {})}`;
    case "ui_transcript":
      return JSON.stringify(p.entry ?? p);
    case "context_action":
      return JSON.stringify(p);
    case "system_note":
      return JSON.stringify(p);
    default:
      return JSON.stringify(p);
  }
}

function buildExcerpt(event: Event, maxLen: number): string {
  const text = eventSearchText(event).replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

export function readSessionMeta(logDir: string, sessionId: string): SessionMeta | null {
  try {
    const metaPath = pathJoin(logDir, sessionId, "meta.json");
    const content = readFileSync(metaPath, "utf-8");
    return JSON.parse(content) as SessionMeta;
  } catch {
    return null;
  }
}

/**
 * Find the most recent session for a given working directory.
 * Picks the session with the latest started_at among cwd matches.
 */
export function findLatestSessionForCwd(logDir: string, cwd: string): string | null {
  if (!existsSync(logDir)) return null;

  const normalizedCwd = resolve(cwd);
  const dirs = readdirSync(logDir, { withFileTypes: true }).filter((d) => d.isDirectory());

  let latestId: string | null = null;
  let latestStartedAt = -1;

  for (const d of dirs) {
    const meta = readSessionMeta(logDir, d.name);
    if (!meta || resolve(meta.cwd) !== normalizedCwd) continue;
    if (meta.started_at > latestStartedAt) {
      latestStartedAt = meta.started_at;
      latestId = meta.session_id;
    }
  }

  return latestId;
}
