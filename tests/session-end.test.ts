import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import { loadConfig } from "../src/config.js";

const sessions: Session[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.end("aborted");
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function start(enabled = true) {
  const home = mkdtempSync(join(tmpdir(), "session-end-"));
  homes.push(home);
  process.env.PRAANA_HOME = home;
  const config = structuredClone(loadConfig());
  config.memory.enabled = enabled;
  config.memory.summarizer = "disabled";
  config.native.enabled = false;
  config.context_engine.enabled = false;
  config.context_engine.measurement_mode = false;
  config.skills.enabled = false;
  config.session.log_dir = join(home, "sessions");
  const session = await Session.create(home, config);
  sessions.push(session);
  return session;
}

it("accepts memoryTimeoutMs but has no session-end memory work", async () => {
  const session = await start();
  const status = await session.end("clean", [], { memoryTimeoutMs: 30 });
  expect(status.memory).toBe("noop");
  expect(status.learningsStored).toBe(0);
  expect(status.turns).toBe(0);
});
it("skips memory when fully disabled and ending twice remains safe", async () => {
  const session = await start(false);
  expect((await session.end("clean")).memory).toBe("skipped");
  expect((await session.end("clean")).memory).toBe("skipped");
});
it("counts successful file recalls without pending reinforcements", async () => {
  const session = await start();
  for (const result of [{ ok: true, matches: [] }, { ok: true, memory: { name: "preference" } }, { ok: false, error: "missing" }]) {
    session.eventLog.append({ kind: "tool_result", actor: "tool", payload: { tool: "recall", result } });
  }
  expect(session.getRecallUsedCount()).toBe(2);
  expect((await session.end("clean")).recallUsed).toBe(2);
  expect(session.getRecallUsedCount()).toBe(2);
});
it("tracks session start metadata and uptime", async () => {
  const session = await start(false);
  expect(session.getStartedAt()).toBeGreaterThan(0);
  expect(session.getUptimeMs()).toBeGreaterThanOrEqual(0);
});
it("reports the startup prompt-index snapshot without an old DB query", async () => {
  const session = await start();
  expect(session.getMemoryPromptIndex()).toEqual({ shown: 0, total: 0 });
  await session.setIncognito(true);
  expect(session.getMemoryPromptIndex()).toEqual({ shown: 0, total: 0 });
});
