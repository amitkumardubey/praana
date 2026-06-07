import { afterEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type * as readline from "node:readline";
import { Session } from "../src/session.js";
import { handleSlashCommand } from "../src/main.js";
import type { AriaConfig } from "../src/types.js";

const testLogDir = join(tmpdir(), "aria-test-session-clear-state");
const testConfig: AriaConfig = {
  llm: { provider: "openrouter", model: "test/model" },
  memory: { enabled: false, summarizer: "disabled", db_path: join(tmpdir(), "aria-test-memory.db") },
  compiler: { token_budget: 100_000, recent_turns: 10, recent_turns_token_budget: 30_000 },
  tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
  session: { log_dir: testLogDir },
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
});

describe("clear slash commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["/clear", "/new"])("%s clears state and logs the triggering command", async (command) => {
    const appended: unknown[] = [];
    const clearState = vi.fn();
    const session = {
      clearState,
      eventLog: {
        append: vi.fn((event: unknown) => appended.push(event)),
      },
    } as unknown as Session;
    const rl = { close: vi.fn() } as unknown as readline.Interface;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleSlashCommand(
      command,
      session,
      rl,
      vi.fn(),
      vi.fn(),
      () => true,
    );

    expect(clearState).toHaveBeenCalledOnce();
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
    expect(log).toHaveBeenCalledWith("State cleared. Starting fresh.");
  });
});
