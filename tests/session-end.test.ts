import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import type { AriaConfig } from "../src/types.js";

const testLogDir = join(tmpdir(), "aria-test-session-end");
const testConfig: AriaConfig = {
  llm: { provider: "openrouter", model: "anthropic/claude-sonnet-4" },
  memory: { enabled: false, summarizer: "disabled", db_path: join(tmpdir(), "aria-test-memory.db") },
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
    await s.end("clean", [], { memoryTimeoutMs: 30 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(400);
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
    await s.end("clean", []);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  it("tracks session start metadata and uptime", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    expect(s.getStartedAt()).toBeGreaterThan(0);
    expect(s.getUptimeMs()).toBeGreaterThanOrEqual(0);
  });

  it("returns persistent memory count from memory store when enabled", async () => {
    const s = await Session.create(process.cwd(), testConfig);
    (s as unknown as { memoryEnabled: boolean }).memoryEnabled = true;
    (s as unknown as { memoryStore: { getEntryCount: () => number } }).memoryStore = {
      getEntryCount: () => 42,
    };
    expect(s.getPersistentMemoryEntryCount()).toBe(42);
  });
});
