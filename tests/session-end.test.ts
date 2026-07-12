import { describe, it, expect, afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import type { PraanaConfig } from "../src/types.js";

const testLogDir = join(tmpdir(), "praana-test-session-end");
const testConfig: PraanaConfig = {
  llm: { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
  memory: { enabled: false, summarizer: "disabled", db_path: join(tmpdir(), "praana-test-memory.db") },
  compiler: { token_budget: 100_000, recent_turns: 10, recent_turns_token_budget: 30_000 },
  tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
  session: { log_dir: testLogDir },
};

describe("Session end timeout behavior", () => {
  afterEach(() => {
    rmSync(testLogDir, { recursive: true, force: true });
  });

  function expectMemory(status: { memory: string }, expected: string) {
    expect(status.memory).toBe(expected);
  }

  it("returns quickly when memory sessionEnd exceeds timeout", async () => {
    const s = await Session.create(process.cwd(), testConfig);

    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { sessionEnd: () => Promise<{ learningsStored: number }> } }).memoryStore = {
      sessionEnd: () => new Promise(() => {}),
    };

    const started = Date.now();
    const status = await s.end("clean", [], { memoryTimeoutMs: 30 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(400);
    expectMemory(status, "background");
    expect(status.learningsStored).toBe(0);
    expect(status.turns).toBeGreaterThanOrEqual(0);
  });

  it("waits for memory sessionEnd when timeout is not provided", async () => {
    const s = await Session.create(process.cwd(), testConfig);

    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { sessionEnd: () => Promise<{ learningsStored: number }> } }).memoryStore = {
      sessionEnd: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ learningsStored: 2 }), 60);
        }),
    };

    const started = Date.now();
    const status = await s.end("clean", []);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(50);
    expectMemory(status, "completed");
    expect(status.learningsStored).toBe(2);
  });

  it("returns 'completed' when summarizer finishes within timeout", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { sessionEnd: () => Promise<{ learningsStored: number }> } }).memoryStore = {
      sessionEnd: () => new Promise((resolve) => setTimeout(() => resolve({ learningsStored: 1 }), 5)),
    };

    const status = await s.end("clean", [], { memoryTimeoutMs: 200 });
    expectMemory(status, "completed");
    expect(status.learningsStored).toBe(1);
  });

  it("returns 'skipped' when memory is disabled", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    // memoryEnabled is false by default in testConfig
    const status = await s.end("clean");
    expectMemory(status, "skipped");
    expect(status.recallUsed).toBe(0);
    expect(status.learningsStored).toBe(0);
  });

  it("returns 'failed' when summarizer throws", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { sessionEnd: () => Promise<{ learningsStored: number }> } }).memoryStore = {
      sessionEnd: () => Promise.reject(new Error("summarizer down")),
    };

    const status = await s.end("clean", [], { memoryTimeoutMs: 0 });
    expectMemory(status, "failed");
    expect(status.learningsStored).toBe(0);
  });

  it("snapshots recallUsed before sessionEnd flush so epilogue stays accurate", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    let countCalls = 0;
    (s as unknown as {
      memoryStore: {
        sessionEnd: () => Promise<{ learningsStored: number }>;
        countPendingReinforcementsUsed: () => number;
      };
    }).memoryStore = {
      countPendingReinforcementsUsed: () => {
        countCalls++;
        return countCalls === 1 ? 3 : 0;
      },
      sessionEnd: async () => ({ learningsStored: 0 }),
    };

    const status = await s.end("clean", [], { memoryTimeoutMs: 200 });
    expectMemory(status, "completed");
    expect(status.recallUsed).toBe(3);
    // Post-flush read would be 0 — epilogue must use the snapshot, not a late read.
    expect(s.getRecallUsedCount()).toBe(0);
  });

  it("tracks session start metadata and uptime", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    expect(s.getStartedAt()).toBeGreaterThan(0);
    expect(s.getUptimeMs()).toBeGreaterThanOrEqual(0);
  });

  it("returns Cognitive Memory entry count from memory store when enabled", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { getEntryCount: () => number } }).memoryStore = {
      getEntryCount: () => 42,
    };
    expect(s.getPersistentMemoryEntryCount()).toBe(42);
  });
});
