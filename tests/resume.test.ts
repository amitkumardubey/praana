// Integration test: session resume with state rebuild
import { describe, it, expect, afterAll } from "vitest";
import { Session } from "../src/session.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AriaConfig } from "../src/types.js";

const testLogDir = join(tmpdir(), "aria-test-sessions");
const testConfig: AriaConfig = {
  llm: { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
  memory: { enabled: false, summarizer: "disabled", db_path: join(tmpdir(), "aria-test-memory.db") },
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
});
