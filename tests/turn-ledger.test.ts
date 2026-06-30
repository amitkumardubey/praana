import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TurnLedger, groupEventsIntoTurns } from "../src/context-engine/turn-ledger.js";
import { TurnRecorder } from "../src/context-engine/turn-recorder.js";
import { ArtifactStore } from "../src/context-engine/artifact-store.js";
import type { Event } from "../src/types.js";
import type { ContextEngineConfig } from "../src/types.js";

const TEST_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 50,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};

function makeEvent(
  kind: Event["kind"],
  payload: Record<string, unknown>,
  index: number,
): Event {
  return {
    event_id: `evt-${index}`,
    session_id: "sess-ledger",
    timestamp: 1_000 + index,
    kind,
    actor: kind === "user_message" ? "user" : "agent",
    payload,
  };
}

describe("turn ledger", () => {
  let ledger: TurnLedger;
  let store: ArtifactStore;

  afterEach(() => {
    store.close();
  });

  beforeEach(() => {
    store = ArtifactStore.open(":memory:", "sess-ledger", TEST_CONFIG);
    ledger = new TurnLedger(store.getDb(), "sess-ledger");
  });

  it("groups events into turns by user_message boundaries", () => {
    const events = [
      makeEvent("user_message", { text: "first" }, 0),
      makeEvent("agent_message", { text: "reply one" }, 1),
      makeEvent("user_message", { text: "second" }, 2),
      makeEvent("agent_message", { text: "reply two" }, 3),
    ];
    const grouped = groupEventsIntoTurns(events);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].userMessage).toBe("first");
    expect(grouped[1].userMessage).toBe("second");
  });

  it("appends turn records and reconstructs artifacts and files", () => {
    const raw = "x".repeat(400);
    const ingested = store.ingestToolResult({
      sourceTool: "read_file",
      command: "src/auth.ts",
      rawText: raw,
      createdTurn: 0,
    });

    const recorder = new TurnRecorder("implement auth");
    recorder.recordToolCall({
      tool: "read_file",
      args: { path: "src/auth.ts" },
      result: { ok: true, content: raw },
      isError: false,
      artifactId: ingested.artifactId,
    });
    recorder.recordToolCall({
      tool: "write_file",
      args: { path: "src/middleware.ts", content: "..." },
      result: { ok: true },
      isError: false,
    });

    ledger.append(recorder.toRecord("added middleware", 0, 1200));

    const record = ledger.get(0);
    expect(record).not.toBeNull();
    expect(record!.artifactIds).toContain(ingested.artifactId);
    expect(record!.filesRead).toContain("src/auth.ts");
    expect(record!.filesWritten).toContain("src/middleware.ts");
    expect(record!.toolCalls).toHaveLength(2);
  });

  it("migrates missing turns from event log on resume", () => {
    const events = [
      makeEvent("user_message", { text: "fix tests" }, 0),
      makeEvent("tool_call", { tool: "shell", args: { command: "npm test" } }, 1),
      makeEvent("tool_result", { tool: "shell", result: { ok: false, error: "2 failed" } }, 2),
      makeEvent("agent_message", { text: "tests are failing" }, 3),
    ];

    const inserted = ledger.migrateFromEvents(events);
    expect(inserted).toBe(1);
    expect(ledger.get(0)?.errors[0]).toContain("2 failed");
    expect(ledger.migrateFromEvents(events)).toBe(0);
  });

  it("searches turns with BM25 ranking", () => {
    ledger.append({
      turn: 0,
      userMessage: "implement jwt auth",
      assistantMessage: "added middleware",
      toolCalls: [],
      artifactIds: [],
      filesRead: ["src/auth.ts"],
      filesWritten: ["src/middleware.ts"],
      errors: [],
      tokenCount: 500,
      timestamp: Date.now(),
    });
    ledger.append({
      turn: 1,
      userMessage: "fix unrelated css bug",
      assistantMessage: "updated styles",
      toolCalls: [],
      artifactIds: [],
      filesRead: ["src/styles.css"],
      filesWritten: [],
      errors: [],
      tokenCount: 300,
      timestamp: Date.now(),
    });

    const matches = ledger.search("jwt middleware auth", 5);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].turn).toBe(0);
    expect(matches[0].filesRead).toContain("src/auth.ts");
  });
});
