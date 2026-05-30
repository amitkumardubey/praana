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
} from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import type { Event, EventActor, EventKind } from "./types.js";

export interface EventSearchOptions {
  kinds?: EventKind[];
  limit?: number;
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
  private sessionId: string;
  private eventCount = 0;
  private closed = false;

  constructor(sessionId: string, logDir: string) {
    this.sessionId = sessionId;
    const sessionDir = join(logDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });
    migrateLegacyEventLog(sessionDir);
    this.logPath = getEventLogPath(sessionDir);
    this.fd = openSync(this.logPath, "a");
  }

  append(event: {
    kind: EventKind;
    actor: EventActor;
    payload: Record<string, unknown>;
    event_id?: string;
    timestamp?: number;
  }): void {
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
    this.eventCount++;
  }

  readLast(n: number): Event[] {
    return this.internalRead().slice(-n);
  }

  readAll(): Event[] {
    return this.internalRead();
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

    const matches: EventSearchMatch[] = [];
    for (const event of this.internalRead()) {
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
    try {
      const content = readFileSync(this.logPath, "utf-8");
      return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Event);
    } catch {
      return [];
    }
  }

  getSessionId(): string {
    return this.sessionId;
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
