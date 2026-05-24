import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import type { Event, EventActor, EventKind } from "./types.js";

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
    this.logPath = join(sessionDir, "events.log");
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

export function readSessionMeta(logDir: string, sessionId: string): SessionMeta | null {
  try {
    const metaPath = pathJoin(logDir, sessionId, "meta.json");
    const content = readFileSync(metaPath, "utf-8");
    return JSON.parse(content) as SessionMeta;
  } catch {
    return null;
  }
}
