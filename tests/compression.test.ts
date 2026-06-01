import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventLog } from "../src/event-log.js";
import { StateGraph } from "../src/state-graph.js";
import type { Event } from "../src/types.js";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "aria-compression-test");

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    event_id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    session_id: "test-session",
    timestamp: Date.now(),
    kind: "user_message",
    actor: "user",
    payload: { text: "test message" },
    ...overrides,
  };
}

describe("EventLog compression checkpoint", () => {
  let logDir: string;

  beforeEach(() => {
    logDir = join(TEST_DIR, `session-${Date.now()}`);
    mkdirSync(logDir, { recursive: true });
  });

  it("marks events as compressed and filters them from readLastUncompressed", () => {
    const sessionDir = join(logDir, "test-session-1");
    mkdirSync(sessionDir, { recursive: true });

    const log = new EventLog("test-session-1", logDir);
    const events: Event[] = [];
    for (let i = 0; i < 10; i++) {
      const ev = makeEvent({
        event_id: `evt-${i}`,
        payload: { text: `message ${i}` },
      });
      events.push(ev);
      log.append(ev);
    }

    // All events visible initially
    expect(log.readLast(10).length).toBe(10);
    expect(log.readLastUncompressed(10).length).toBe(10);

    // Mark first 3 as compressed
    log.markEventsAsCompressed(["evt-0", "evt-1", "evt-2"]);

    // readLast still returns all
    expect(log.readLast(10).length).toBe(10);

    // readLastUncompressed excludes compressed ones
    const uncompressed = log.readLastUncompressed(10);
    expect(uncompressed.length).toBe(7);
    expect(uncompressed.every((e) => !["evt-0", "evt-1", "evt-2"].includes(e.event_id))).toBe(true);

    log.close();
  });

  it("persists compression checkpoint across EventLog instances", () => {
    const sessionId = "test-session-persist";
    const sessionDir = join(logDir, sessionId);
    mkdirSync(sessionDir, { recursive: true });

    // First instance: write events and compress some
    const log1 = new EventLog(sessionId, logDir);
    for (let i = 0; i < 5; i++) {
      log1.append(makeEvent({ event_id: `evt-${i}`, payload: { text: `msg ${i}` } }));
    }
    log1.markEventsAsCompressed(["evt-0", "evt-1"]);
    log1.close();

    // Second instance: should load checkpoint
    const log2 = new EventLog(sessionId, logDir);
    const uncompressed = log2.readLastUncompressed(10);
    expect(uncompressed.length).toBe(3);
    expect(log2.getCompressedCount()).toBe(2);
    log2.close();
  });

  it("getCompressedCount returns correct count", () => {
    const sessionDir = join(logDir, "test-session-count");
    mkdirSync(sessionDir, { recursive: true });

    const log = new EventLog("test-session-count", logDir);
    expect(log.getCompressedCount()).toBe(0);

    log.markEventsAsCompressed(["a", "b", "c"]);
    expect(log.getCompressedCount()).toBe(3);

    log.markEventsAsCompressed(["d"]);
    expect(log.getCompressedCount()).toBe(4);

    log.close();
  });
});

describe("summarizeTurns", () => {
  it("exists and is importable from summarizer", async () => {
    const { summarizeTurns } = await import("../src/memory/summarizer.js");
    expect(typeof summarizeTurns).toBe("function");
  });
});

describe("MemoryStore.compressTurns", () => {
  it("exists and is callable", async () => {
    const { MemoryStore } = await import("../src/memory/store.js");
    expect(typeof MemoryStore.prototype.compressTurns).toBe("function");
  });
});
