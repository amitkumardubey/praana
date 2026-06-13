import { describe, it, expect } from "vitest";
import { Session } from "../src/session.js";
import type { PraanaConfig } from "../src/types.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testConfig: PraanaConfig = {
  llm: { provider: "openrouter", model: "test/model" },
  memory: { enabled: true, summarizer: "disabled", db_path: ":memory:" },
  compiler: { token_budget: 100_000, recent_turns: 10 },
  tiers: { idle_soft_after_turns: 20, idle_hard_after_turns: 50 },
  session: { log_dir: join(tmpdir(), "praana-incognito-test") },
};

describe("incognito mode", () => {
  it("starts without memory when incognito flag is set", async () => {
    const session = await Session.create(process.cwd(), testConfig, { incognito: true });
    expect(session.isIncognito()).toBe(true);
    expect(session.memoryEnabled).toBe(false);
    expect(session.memoryStore).toBeNull();
    expect(session.digest).toBeNull();
  });
});
