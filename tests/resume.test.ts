// Integration test: session resume with state rebuild
import { describe, it, expect, afterAll } from "bun:test";
import { Session } from "../src/session.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PraanaConfig } from "../src/types.js";
import {
  loadStateGraphCheckpoint,
  replayStateGraphFromEvents,
} from "../src/state-graph-checkpoint.js";

const testLogDir = join(tmpdir(), "praana-test-sessions");
const testConfig: PraanaConfig = {
  llm: { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
  memory: { enabled: false, summarizer: "disabled", db_path: join(tmpdir(), "praana-test-memory.db") },
  compiler: { token_budget: 100_000, recent_turns: 10, recent_turns_token_budget: 30_000 },
  tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
  session: { log_dir: testLogDir },
};

describe("Session resume", () => {
  let sessionId: string;
  let task1Id: string;

  afterAll(() => {
    // Clean up test session dirs
    try {
      const dir = join(testLogDir, sessionId);
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("creates session with state objects", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    sessionId = s.id;

    const t1 = s.stateGraph.create("task", { title: "Fix resume bug", status: "todo" });
    task1Id = t1.id;
    s.stateGraph.create("task", { title: "Add /sessions command", status: "todo" });
    s.stateGraph.create("constraint", { text: "Keep it simple" });

    // Log context actions (normally done by tools)
    for (const obj of s.stateGraph.list()) {
      const full = s.stateGraph.get(obj.id)!;
      s.eventLog.append({
        kind: "context_action",
        actor: "kernel",
        payload: {
          action: "create",
          id: full.id,
          kind: full.kind,
          tier: full.tier,
          statePayload: full.payload,
          created: full.created,
          updated: full.updated,
          lastTouched: full.lastTouched,
        },
      });
    }
    s.stateGraph.setTier(task1Id, "soft");
    const t1obj = s.stateGraph.get(task1Id)!;
    s.eventLog.append({
      kind: "context_action",
      actor: "kernel",
      payload: { action: "setTier", id: task1Id, tier: "soft", lastTouched: t1obj.lastTouched },
    });

    await s.end("clean");
    expect(sessionId).toBeTruthy();
  });

  it("resumes and rebuilds state correctly", async () => {
    const s = await Session.resume(sessionId, process.cwd(), testConfig);
    
    const objects = s.stateGraph.list();
    // 2 tasks + 1 test constraint + 1 project context constraint (if cwd has config files)
    const hasProjectContext = objects.some(
      (o) => o.kind === "constraint" && o.payload && (o.payload as any).text?.startsWith("Project:")
    );
    const expectedMinCount = hasProjectContext ? 4 : 3;
    expect(objects.length).toBeGreaterThanOrEqual(expectedMinCount);

    const active = s.stateGraph.getActive();
    const peripheral = s.stateGraph.getPeripheral();
    // 1 task + 1 test constraint + optionally 1 project context constraint
    const expectedActiveMin = hasProjectContext ? 3 : 2;
    expect(active.length).toBeGreaterThanOrEqual(expectedActiveMin);
    expect(peripheral).toHaveLength(1); // 1 soft task

    // Verify task payloads survived round-trip
    const softTask = peripheral[0];
    expect(softTask.kind).toBe("task");
    expect((softTask.payload as any).title).toBe("Fix resume bug");

    await s.end("clean");
  });

  it("resumes without crashing", async () => {
    const s = await Session.resume(sessionId, process.cwd(), testConfig);
    expect(s.id).toBe(sessionId);
    expect(s.stateGraph.list().length).toBeGreaterThan(0);
    await s.end("clean");
  });

  it("resumes from checkpoint with incremental replay", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    const sid = s.id;
    const sessionDir = join(testLogDir, sid);

    for (let i = 0; i < 50; i++) {
      const obj = s.stateGraph.create("note", { text: `note-${i}` });
      s.eventLog.append({
        kind: "context_action",
        actor: "kernel",
        payload: {
          action: "create",
          id: obj.id,
          kind: obj.kind,
          tier: obj.tier,
          statePayload: obj.payload,
          created: obj.created,
          updated: obj.updated,
          lastTouched: obj.lastTouched,
        },
      });
    }
    s.persistStateGraphCheckpoint();

    const events = s.eventLog.readAll();
    const checkpoint = loadStateGraphCheckpoint(sessionDir);
    expect(checkpoint).not.toBeNull();

    const resumed = await Session.resume(sid, process.cwd(), testConfig);
    expect(resumed.stateGraph.list().length).toBe(50);

    const replayed = replayStateGraphFromEvents(
      resumed.stateGraph,
      events,
      events.length,
    );
    expect(replayed).toBe(0);

    await resumed.end("clean");
    rmSync(sessionDir, { recursive: true, force: true });
  });

  it("isResumed is true immediately after resume and false after a turn", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    const sid = s.id;

    const task = s.stateGraph.create("task", { title: "Old task", status: "todo" });
    s.eventLog.append({
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
    s.persistStateGraphCheckpoint();
    await s.end("clean");

    const resumed = await Session.resume(sid, process.cwd(), testConfig);
    expect(resumed.isResumed()).toBe(true);

    // Simulate the post-resume turn advancing.
    resumed.incrementTurn();
    resumed.clearResumed();
    expect(resumed.isResumed()).toBe(false);

    await resumed.end("clean");
    rmSync(join(testLogDir, sid), { recursive: true, force: true });
  });

  it("getStaleTasks returns active tasks untouched for more than the threshold", async () => {
    const threshold = 3;
    const cfg: PraanaConfig = { ...testConfig, session: { ...testConfig.session, stale_task_turn_threshold: threshold } };
    const s = await Session.create(process.cwd(), cfg);
    const sid = s.id;

    const freshTask = s.stateGraph.create("task", { title: "Fresh task", status: "todo" });
    s.eventLog.append({
      kind: "context_action",
      actor: "kernel",
      payload: {
        action: "create",
        id: freshTask.id,
        kind: freshTask.kind,
        tier: freshTask.tier,
        statePayload: freshTask.payload,
        created: freshTask.created,
        updated: freshTask.updated,
        lastTouched: freshTask.lastTouched,
      },
    });

    const staleTask = s.stateGraph.create("task", { title: "Stale task", status: "todo" });
    s.eventLog.append({
      kind: "context_action",
      actor: "kernel",
      payload: {
        action: "create",
        id: staleTask.id,
        kind: staleTask.kind,
        tier: staleTask.tier,
        statePayload: staleTask.payload,
        created: staleTask.created,
        updated: staleTask.updated,
        lastTouched: staleTask.lastTouched,
      },
    });

    // Advance turns so the second task becomes stale relative to the checkpoint.
    for (let i = 0; i < threshold + 1; i++) {
      s.incrementTurn();
    }
    // Touch the first task on the final turn so it is not considered stale.
    s.stateGraph.update(freshTask.id, { title: "Fresh task" });
    s.persistStateGraphCheckpoint();
    await s.end("clean");

    const resumed = await Session.resume(sid, process.cwd(), cfg);
    const stale = resumed.getStaleTasks();
    expect(stale.length).toBe(1);
    expect((stale[0].payload as any).title).toBe("Stale task");

    await resumed.end("clean");
    rmSync(join(testLogDir, sid), { recursive: true, force: true });
  });

  it("resumes plan mode state from system_note events", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    const sid = s.id;
    const sessionDir = join(testLogDir, sid);

    s.enterPlanMode();
    await s.end("clean");

    const resumedOn = await Session.resume(sid, process.cwd(), testConfig);
    expect(resumedOn.isPlanMode()).toBe(true);
    await resumedOn.end("clean");

    const resumedOff = await Session.resume(sid, process.cwd(), testConfig);
    expect(resumedOff.isPlanMode()).toBe(true);
    resumedOff.exitPlanMode();
    await resumedOff.end("clean");

    const resumedFinal = await Session.resume(sid, process.cwd(), testConfig);
    expect(resumedFinal.isPlanMode()).toBe(false);
    await resumedFinal.end("clean");

    rmSync(sessionDir, { recursive: true, force: true });
  });
});
