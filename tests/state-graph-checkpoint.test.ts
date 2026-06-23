import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateGraph } from "../src/state-graph.js";
import {
  deleteStateGraphCheckpoint,
  findReplayStartIndex,
  getStateGraphCheckpointPath,
  loadStateGraphCheckpoint,
  replayStateGraphFromEvents,
  saveStateGraphCheckpoint,
} from "../src/state-graph-checkpoint.js";
import type { Event } from "../src/types.js";

const TEST_DIR = join(tmpdir(), "praana-state-graph-checkpoint-test");

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    event_id: overrides.event_id ?? `evt-${Math.random().toString(36).slice(2, 8)}`,
    session_id: "sess-1",
    timestamp: Date.now(),
    kind: "user_message",
    actor: "user",
    payload: { text: "hello" },
    ...overrides,
  };
}

describe("StateGraph checkpoint serde", () => {
  it("round-trips objects, tiers, focused, retracted, and touched_turn", () => {
    const sg = new StateGraph();
    sg.incrementTurn();
    sg.incrementTurn();
    const task = sg.create("task", { title: "A", status: "todo" });
    sg.setFocus(task.id);
    const note = sg.create("note", { text: "sticky" });
    sg.setTier(note.id, "soft");
    sg.retractObject(note.id);

    const checkpoint = sg.exportCheckpoint("anchor-id", 7);
    expect(checkpoint.version).toBe(1);
    expect(checkpoint.last_event_id).toBe("anchor-id");
    expect(checkpoint.session_turn_count).toBe(7);
    expect(checkpoint.state_graph_turn_count).toBe(2);
    expect(checkpoint.objects).toHaveLength(2);

    const restored = new StateGraph();
    restored.restoreFromCheckpoint(checkpoint);

    expect(restored.getTurnCount()).toBe(2);
    expect(restored.getTouchedTurn(task.id)).toBe(2);
    expect(restored.get(task.id)?.focused).toBe(true);
    expect(restored.get(note.id)?.retracted).toBe(true);
    expect(restored.get(note.id)?.tier).toBe("soft");
  });
});

describe("StateGraph checkpoint I/O", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = join(TEST_DIR, `sess-${Date.now()}`);
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("persists and loads checkpoint from disk", () => {
    const sg = new StateGraph();
    sg.create("constraint", { text: "no any" });
    const data = sg.exportCheckpoint("evt-99", 3);
    saveStateGraphCheckpoint(sessionDir, data);

    const loaded = loadStateGraphCheckpoint(sessionDir);
    expect(loaded?.last_event_id).toBe("evt-99");
    expect(loaded?.objects).toHaveLength(1);
    expect(getStateGraphCheckpointPath(sessionDir)).toContain(
      "state_graph_checkpoint.json",
    );
  });

  it("returns null for corrupt checkpoint", () => {
    writeFileSync(
      getStateGraphCheckpointPath(sessionDir),
      "{ not valid json",
      "utf-8",
    );
    expect(loadStateGraphCheckpoint(sessionDir)).toBeNull();
  });

  it("deletes checkpoint file", () => {
    const sg = new StateGraph();
    saveStateGraphCheckpoint(sessionDir, sg.exportCheckpoint("x", 0));
    deleteStateGraphCheckpoint(sessionDir);
    expect(loadStateGraphCheckpoint(sessionDir)).toBeNull();
  });
});

describe("incremental state replay", () => {
  it("findReplayStartIndex returns index after anchor event", () => {
    const events = [
      makeEvent({ event_id: "e1" }),
      makeEvent({ event_id: "e2", kind: "context_action", payload: { action: "create" } }),
      makeEvent({ event_id: "e3" }),
    ];
    expect(findReplayStartIndex(events, "e2")).toBe(2);
    expect(findReplayStartIndex(events, "missing")).toBeNull();
  });

  it("incremental replay matches full replay for scripted sequence", () => {
    const events: Event[] = [
      makeEvent({ event_id: "e0" }),
      makeEvent({
        event_id: "e1",
        kind: "context_action",
        actor: "kernel",
        payload: {
          action: "create",
          id: "01TASK",
          kind: "task",
          tier: "active",
          statePayload: { title: "One", status: "todo" },
          created: 1,
          updated: 1,
          lastTouched: 1,
        },
      }),
      makeEvent({
        event_id: "e2",
        kind: "context_action",
        actor: "kernel",
        payload: {
          action: "setTier",
          id: "01TASK",
          tier: "soft",
          lastTouched: 2,
        },
      }),
      makeEvent({
        event_id: "e3",
        kind: "context_action",
        actor: "kernel",
        payload: {
          action: "create",
          id: "02TASK",
          kind: "task",
          tier: "active",
          statePayload: { title: "Two", status: "todo" },
          created: 3,
          updated: 3,
          lastTouched: 3,
        },
      }),
    ];

    // Full-replay baseline
    const full = new StateGraph();
    replayStateGraphFromEvents(full, events, 0);

    // Checkpoint-based: restore state as of e1, then replay e2 onwards
    const fromCheckpoint = new StateGraph();
    fromCheckpoint.restoreFromCheckpoint({
      version: 1,
      saved_at: Date.now(),
      last_event_id: "e1",
      session_turn_count: 1,
      state_graph_turn_count: 1,
      objects: [
        {
          id: "01TASK",
          kind: "task",
          tier: "active",
          payload: { title: "One", status: "todo" },
          created: 1,
          updated: 1,
          lastTouched: 1,
        },
      ],
      touched_turn: { "01TASK": 1 },
    });
    replayStateGraphFromEvents(fromCheckpoint, events, 2);

    expect(fromCheckpoint.list().map((o) => o.summary)).toEqual(
      full.list().map((o) => o.summary),
    );
    expect(fromCheckpoint.get("01TASK")?.tier).toBe("soft");
    expect(fromCheckpoint.get("02TASK")?.tier).toBe("active");
  });

  it("counts only replayed state mutations", () => {
    const events: Event[] = [
      makeEvent({ event_id: "e0" }),
      makeEvent({
        event_id: "e1",
        kind: "context_action",
        actor: "kernel",
        payload: { action: "create", id: "x", kind: "note", tier: "active", statePayload: { text: "a" }, created: 1, updated: 1, lastTouched: 1 },
      }),
      makeEvent({ event_id: "e2", kind: "user_message", payload: { text: "hi" } }),
      makeEvent({
        event_id: "e3",
        kind: "context_action",
        actor: "kernel",
        payload: { action: "create", id: "y", kind: "note", tier: "active", statePayload: { text: "b" }, created: 2, updated: 2, lastTouched: 2 },
      }),
    ];
    const sg = new StateGraph();
    const replayed = replayStateGraphFromEvents(sg, events, 2);
    expect(replayed).toBe(1);
    expect(sg.list()).toHaveLength(1);
  });
});
