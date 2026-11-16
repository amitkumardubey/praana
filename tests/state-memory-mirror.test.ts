import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory/index.js";
import { Session } from "../src/session.js";
import { runTurn } from "../src/turn.js";
import { loadConfig } from "../src/config.js";
import { scriptedMemoryModel } from "./helpers/scripted-memory-model.js";

let home: string;
let session: Session;
let model: ReturnType<typeof scriptedMemoryModel>;
let remember: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "state-no-mirror-"));
  process.env.PRAANA_HOME = home;
});
afterEach(async () => {
  if (session) await session.end("aborted");
  remember?.mockRestore();
  model?.close();
  rmSync(home, { recursive: true, force: true });
});

it.each([
  { name: "add_constraint", args: { text: "Use pnpm, not npm" }, kind: "constraint" },
  { name: "decide", args: { summary: "Use TypeScript", rationale: "Type safety" }, kind: "decision" },
])("$name stays in working memory and never mirrors into Cognitive Memory", async ({ name, args, kind }) => {
  const config = structuredClone(loadConfig());
  config.memory = { ...config.memory, enabled: true, summarizer: "disabled", db_path: join(home, "context.db") };
  config.native.enabled = false;
  config.context_engine.enabled = true;
  config.skills.enabled = false;
  config.session.log_dir = join(home, "sessions");
  model = scriptedMemoryModel(config, [[{ name, args }]]);
  session = await Session.create(home, config);
  remember = spyOn(MemoryStore.prototype, "remember");
  await runTurn(session, "Record this constraint or decision", undefined, { sink: {} });
  expect(remember).not.toHaveBeenCalled(); // main's registered state tools automatically mirror
  expect(session.stateGraph.snapshot().some((object) => object.kind === kind)).toBe(true);
  expect(session.eventLog.readAll().some((event) => event.payload.type === "memory_mirror")).toBe(false);
  expect((await session.fileMemory!.list()).entries).toEqual([]);
});
