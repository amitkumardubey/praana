import { describe, it, expect, afterEach, mock } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import { executeSlashCommand } from "../src/slash-commands.js";
import type { PraanaConfig } from "../src/types.js";

const testLogDir = join(tmpdir(), "praana-test-session-clear-state");
const testConfig: PraanaConfig = {
  llm: { provider: "openrouter", model: "test/model" },
  memory: { enabled: false, summarizer: "disabled", db_path: join(tmpdir(), "praana-test-memory.db") },
  compiler: { token_budget: 100_000, recent_turns: 10, recent_turns_token_budget: 30_000 },
  tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
  session: { log_dir: testLogDir },
  ui: { mode: "readline", screen: "preserve" },
};

describe("Session.clearState", () => {
  afterEach(() => {
    rmSync(testLogDir, { recursive: true, force: true });
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
});

describe("clear slash commands", () => {
  afterEach(() => {
    mock.restore();
  });

  it.each(["/clear", "/new"])("%s clears state and logs the triggering command", async (command) => {
    const appended: unknown[] = [];
    const clearState = mock();
    const session = {
      clearState,
      persistStateGraphCheckpoint: mock(),
      eventLog: {
        append: mock((event: unknown) => appended.push(event)),
      },
    } as unknown as Session;
    const result = await executeSlashCommand(command, session, {
      setModel: mock(),
      setThinking: mock(),
      getThinking: () => true,
    });

    expect(clearState).toHaveBeenCalledOnce();
    expect(session.persistStateGraphCheckpoint).toHaveBeenCalledOnce();
    expect(appended).toEqual([
      {
        kind: "system_note",
        actor: "kernel",
        payload: {
          type: "state_reset",
          cleared: "all",
          command,
        },
      },
    ]);
    expect(result.lines).toContain("State cleared. Starting fresh.");
  });
});
