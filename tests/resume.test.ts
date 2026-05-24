// Integration test: session resume with state rebuild
import { describe, it, expect, afterAll } from "vitest";
import { Session } from "../src/session.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

describe("Session resume", () => {
  let sessionId: string;
  let task1Id: string;

  afterAll(() => {
    // Clean up test session dirs
    try {
      const dir = join(homedir(), ".aria", "sessions", sessionId);
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("creates session with state objects", async () => {
    const s = await Session.create(process.cwd());
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
    const s = await Session.resume(sessionId, process.cwd());
    
    const objects = s.stateGraph.list();
    expect(objects).toHaveLength(3);
    
    const active = s.stateGraph.getActive();
    const peripheral = s.stateGraph.getPeripheral();
    expect(active).toHaveLength(2); // 1 task + 1 constraint
    expect(peripheral).toHaveLength(1); // 1 soft task

    // Verify task payloads survived round-trip
    const softTask = peripheral[0];
    expect(softTask.kind).toBe("task");
    expect((softTask.payload as any).title).toBe("Fix resume bug");

    await s.end("clean");
  });

  it("resumes without crashing", async () => {
    const s = await Session.resume(sessionId, process.cwd());
    expect(s.id).toBe(sessionId);
    expect(s.stateGraph.list().length).toBeGreaterThan(0);
    await s.end("clean");
  });
});
