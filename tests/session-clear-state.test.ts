import { describe, it, expect, afterEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session, visibleCheckpointAfterBoundary } from "../src/session.js";
import { executeSlashCommand } from "../src/slash-commands.js";
import { createEmptyCheckpoint } from "../src/context-engine/checkpoint.js";
import type { CheckpointDraft, TurnDigest } from "../src/context-engine/types.js";
import type { PraanaConfig } from "../src/types.js";
import type { SessionCheckpoint } from "../src/context-engine/types.js";

const testRoot = mkdtempSync(join(tmpdir(), "praana-test-session-clear-"));
const testLogDir = join(testRoot, "sessions");
const testConfig: PraanaConfig = {
  llm: { provider: "openrouter", model: "test/model" },
  memory: { enabled: false, summarizer: "disabled", db_path: join(testRoot, "memory.db") },
  compiler: { token_budget: 100_000, recent_turns: 10, recent_turns_token_budget: 30_000 },
  tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
  session: { log_dir: testLogDir },
  ui: { mode: "readline", screen: "preserve" },
};

describe("Session.clearState", () => {
  afterEach(() => {
    rmSync(testLogDir, { recursive: true, force: true });
  });

  afterAll(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it("clears working-memory state without resetting session turns", async () => {
    const session = await Session.create(process.cwd(), testConfig);
    session.stateGraph.create("task", { title: "Clear me", status: "todo" });
    session.incrementTurn();
    session.incrementTurn();

    expect(session.getTurnCount()).toBe(2);
    expect(session.stateGraph.getTurnCount()).toBe(2);

    session.clearState();

    expect(session.stateGraph.list()).toEqual([]);
    expect(session.stateGraph.getTurnCount()).toBe(0);
    expect(session.getTurnCount()).toBe(2);
  });

  it("does not restore cleared state when resuming the session", async () => {
    const session = await Session.create(process.cwd(), testConfig);
    const task = session.stateGraph.create("task", { title: "Clear me", status: "todo" });
    session.eventLog.append({
      kind: "context_action",
      actor: "kernel",
      payload: {
        action: "create",
        id: task.id,
        kind: task.kind,
        tier: task.tier,
        statePayload: task.payload,
        created: task.created,
        updated: task.updated,
        lastTouched: task.lastTouched,
      },
    });
    session.clearState();
    session.eventLog.append({
      kind: "system_note",
      actor: "kernel",
      payload: {
        type: "state_reset",
        cleared: "all",
        command: "/clear",
      },
    });
    session.persistStateGraphCheckpoint();

    const resumed = await Session.resume(session.id, process.cwd(), testConfig);

    expect(resumed.stateGraph.list()).toEqual([]);
  });

  it("/clear with no prior turns reports boundary turn -1 (nothing to hide)", async () => {
    const session = await Session.create(process.cwd(), testConfig);
    // No incrementTurn, no user messages — immediate /clear.
    expect(session.getLastResetBoundaryTurn()).toBe(-1);
    session.logResetBoundary("/clear");
    // No user_message events precede the boundary → boundary turn stays -1,
    // meaning compile filters degrade to "include all" (correct: nothing pre-clear).
    expect(session.getLastResetBoundaryTurn()).toBe(-1);
  });
});

describe("clear slash commands", () => {
  afterEach(() => {
    mock.restore();
  });

  it("/clear resets in-session context and logs a reset boundary", async () => {
    const order: string[] = [];
    const session = {
      clearState: mock(() => { order.push("clearState"); }),
      logResetBoundary: mock((cmd: string) => {
        order.push("logResetBoundary");
        return cmd;
      }),
      recalculateContextBaseline: mock(() => { order.push("recalc"); }),
      persistStateGraphCheckpoint: mock(() => { order.push("persist"); }),
      contextEngine: { resetContext: mock(() => { order.push("resetContext"); }) },
      eventLog: { append: mock() },
    } as unknown as Session;

    const result = await executeSlashCommand("/clear", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(session.clearState).toHaveBeenCalledOnce();
    expect(session.logResetBoundary).toHaveBeenCalledWith("/clear");
    expect(session.contextEngine.resetContext).toHaveBeenCalledOnce();
    expect(session.recalculateContextBaseline).toHaveBeenCalledOnce();
    expect(session.persistStateGraphCheckpoint).toHaveBeenCalledOnce();
    // Order matters: the boundary must be logged before the state-graph
    // checkpoint anchors on it, and resetContext before recalculation.
    expect(order).toEqual([
      "clearState",
      "logResetBoundary",
      "resetContext",
      "recalc",
      "persist",
    ]);
    expect(result.action).toBe("clear_transcript");
    expect(result.lines).toContain("In-session context cleared. Session ID unchanged.");
  });

  it("/clear works in classic mode (contextEngine null) without throwing", async () => {
    const session = {
      clearState: mock(),
      logResetBoundary: mock(),
      recalculateContextBaseline: mock(),
      persistStateGraphCheckpoint: mock(),
      contextEngine: undefined,
      eventLog: { append: mock() },
    } as unknown as Session;

    const result = await executeSlashCommand("/clear", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(session.clearState).toHaveBeenCalledOnce();
    expect(session.logResetBoundary).toHaveBeenCalledWith("/clear");
    expect(session.recalculateContextBaseline).toHaveBeenCalledOnce();
    expect(result.action).toBe("clear_transcript");
  });

  it("/clear and /new refuse to run while a turn is active", async () => {
    const session = {
      clearState: mock(),
      logResetBoundary: mock(),
      recalculateContextBaseline: mock(),
      persistStateGraphCheckpoint: mock(),
      contextEngine: { resetContext: mock() },
      eventLog: { append: mock() },
    } as unknown as Session;

    for (const cmd of ["/clear", "/new"]) {
      const result = await executeSlashCommand(cmd, session, {
        setModel: mock(),
        setThinking: mock(),
        getThinking: () => true,
        isTurnActive: () => true,
      });
      expect(result.action).toBe("none");
      expect(result.toastTone).toBe("error");
      expect(result.lines.some((l) => l.includes("turn is still running"))).toBe(true);
    }
    expect(session.clearState).not.toHaveBeenCalled();
    expect(session.logResetBoundary).not.toHaveBeenCalled();
  });

  it("/new returns a new_session action without touching current session state", async () => {
    const session = {
      clearState: mock(),
      logResetBoundary: mock(),
      recalculateContextBaseline: mock(),
      persistStateGraphCheckpoint: mock(),
      contextEngine: { resetContext: mock() },
      eventLog: { append: mock() },
    } as unknown as Session;

    const result = await executeSlashCommand("/new", session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(session.clearState).not.toHaveBeenCalled();
    expect(session.logResetBoundary).not.toHaveBeenCalled();
    expect(session.recalculateContextBaseline).not.toHaveBeenCalled();
    expect(session.persistStateGraphCheckpoint).not.toHaveBeenCalled();
    expect(session.contextEngine.resetContext).not.toHaveBeenCalled();
    expect(result.action).toBe("new_session");
    expect(result.lines).toContain("Starting a new session…");
  });
});

describe("visibleCheckpointAfterBoundary", () => {
  function checkpointWith(reconciledTurn: number): SessionCheckpoint {
    const cp = createEmptyCheckpoint();
    cp.state.lastReconciledTurn = reconciledTurn;
    return cp;
  }

  it("returns the checkpoint as-is when no reset boundary exists (-1)", () => {
    const cp = checkpointWith(5);
    expect(visibleCheckpointAfterBoundary(cp, -1)).toBe(cp);
  });

  it("replaces a stale pre-clear checkpoint with an empty one", () => {
    const cp = checkpointWith(2);
    const visible = visibleCheckpointAfterBoundary(cp, 3);
    expect(visible).not.toBe(cp);
    expect(visible.state.lastReconciledTurn).toBe(-1);
    expect(visible.state.activeRequest).toBe("");
  });

  it("replaces a checkpoint reconciled exactly at the boundary turn", () => {
    const cp = checkpointWith(3);
    const visible = visibleCheckpointAfterBoundary(cp, 3);
    expect(visible).not.toBe(cp);
    expect(visible.state.lastReconciledTurn).toBe(-1);
  });

  it("keeps a post-clear checkpoint reconciled after the boundary (regression for issue #180)", () => {
    // /clear after turn 2 (boundaryTurn = 2). First post-clear turn reconciles
    // the checkpoint at turn 3. The engine must keep showing that post-clear
    // state, not discard it as stale.
    const postClearCp = checkpointWith(3);
    const visible = visibleCheckpointAfterBoundary(postClearCp, 2);
    expect(visible).toBe(postClearCp);
    expect(visible.state.lastReconciledTurn).toBe(3);
  });
});

describe("Session.getVisibleSessionCheckpoint (integration)", () => {
  const intDir = mkdtempSync(join(tmpdir(), "praana-test-session-clear-int-"));
  let dbPath: string;

  function makeDigest(overrides: Partial<TurnDigest> = {}): TurnDigest {
    return {
      turnId: 0,
      userIntent: "implement auth",
      filesChanged: [],
      filesWritten: [],
      artifactRefs: [],
      decisions: [],
      constraints: [],
      errorsNew: [],
      errorsFixed: [],
      toolSummary: "no tools",
      ...overrides,
    };
  }
  function makeDraft(overrides: Partial<CheckpointDraft> = {}): CheckpointDraft {
    return {
      lastUserIntent: "",
      openErrors: [],
      recentDecisions: [],
      recentConstraints: [],
      recentActivity: [],
      ...overrides,
    };
  }
  function makeConfig(): PraanaConfig {
    dbPath = join(tmpdir(), `praana-test-ctx-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    return {
      llm: { provider: "openrouter", model: "test/model" },
      memory: { enabled: false, summarizer: "disabled", db_path: dbPath },
      compiler: { token_budget: 100_000, recent_turns: 10, recent_turns_token_budget: 30_000 },
      tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
      session: { log_dir: intDir },
      ui: { mode: "readline", screen: "preserve" },
      context_engine: {
        enabled: true,
        measurement_mode: false,
        artifact_inline_threshold: 400,
        artifact_ttl_turns: 50,
        distiller: { default_intensity: "full" },
        llm_digest: false,
        activity_log_max_entries: 15,
        checkpoint_enabled: true,
        scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3 },
        pressure: { compact_at: 0.7, emergency_at: 0.85 },
      },
    };
  }

  afterEach(() => {
    rmSync(intDir, { recursive: true, force: true });
    if (dbPath) rmSync(dbPath, { force: true });
  });

  it("hides a pre-clear checkpoint and keeps a post-clear one across /clear", async () => {
    const session = await Session.create(process.cwd(), makeConfig());
    const ce = session.contextEngine;
    expect(ce).toBeDefined();
    expect(ce!.checkpoint).toBeDefined();

    // Two user turns before /clear → boundary turn becomes 1.
    session.eventLog.append({ kind: "user_message", actor: "user", payload: { text: "q1" } });
    session.eventLog.append({ kind: "user_message", actor: "user", payload: { text: "q2" } });

    // Reconcile a checkpoint at turn 1 (== boundary turn after /clear) → stale.
    ce!.checkpoint!.reconcile(makeDigest({ turnId: 1, userIntent: "stale" }), makeDraft(), 1);
    ce!.checkpoint!.persist();

    // Pre-clear: checkpoint is visible as-is.
    expect(session.getVisibleSessionCheckpoint()?.state.lastReconciledTurn).toBe(1);

    // /clear sets the boundary at turn 1.
    session.logResetBoundary("/clear");
    expect(session.getLastResetBoundaryTurn()).toBe(1);

    // Stale checkpoint (reconciled at the boundary turn) is replaced with empty.
    const afterClear = session.getVisibleSessionCheckpoint();
    expect(afterClear?.state.lastReconciledTurn).toBe(-1);

    // A subsequent post-clear turn reconciles a fresh checkpoint at turn 2.
    ce!.checkpoint!.reconcile(makeDigest({ turnId: 2, userIntent: "fresh" }), makeDraft(), 2);
    ce!.checkpoint!.persist();
    const postClear = session.getVisibleSessionCheckpoint();
    expect(postClear?.state.lastReconciledTurn).toBe(2);
  });
});
