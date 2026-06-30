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

  it("returns quickly when memory sessionEnd exceeds timeout", async () => {
    const s = await Session.create(process.cwd(), testConfig);

    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { sessionEnd: () => Promise<void> } }).memoryStore = {
      sessionEnd: () => new Promise<void>(() => {}),
    };

    const started = Date.now();
    const status = await s.end("clean", [], { memoryTimeoutMs: 30 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(400);
    expect(status).toEqual({ memory: "background" });
  });

  it("waits for memory sessionEnd when timeout is not provided", async () => {
    const s = await Session.create(process.cwd(), testConfig);

    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { sessionEnd: () => Promise<void> } }).memoryStore = {
      sessionEnd: () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 60);
        }),
    };

    const started = Date.now();
    const status = await s.end("clean", []);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(status).toEqual({ memory: "completed" });
  });

  it("returns 'completed' when summarizer finishes within timeout", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { sessionEnd: () => Promise<void> } }).memoryStore = {
      sessionEnd: () => new Promise<void>((resolve) => setTimeout(resolve, 5)),
    };

    const status = await s.end("clean", [], { memoryTimeoutMs: 200 });
    expect(status).toEqual({ memory: "completed" });
  });

  it("returns 'skipped' when memory is disabled", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    // memoryEnabled is false by default in testConfig
    const status = await s.end("clean");
    expect(status).toEqual({ memory: "skipped" });
  });

  it("returns 'failed' when summarizer throws", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { sessionEnd: () => Promise<void> } }).memoryStore = {
      sessionEnd: () => Promise.reject(new Error("summarizer down")),
    };

    const status = await s.end("clean", [], { memoryTimeoutMs: 0 });
    expect(status).toEqual({ memory: "failed" });
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
