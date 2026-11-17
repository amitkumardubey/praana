import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import { runTurn } from "../src/turn.js";
import { loadConfig } from "../src/config.js";
import { scriptedMemoryModel } from "./helpers/scripted-memory-model.js";

let home: string;
let session: Session;
let model: ReturnType<typeof scriptedMemoryModel>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "state-no-mirror-"));
  process.env.PRAANA_HOME = home;
});
afterEach(async () => {
  if (session) await session.end("aborted");
  model?.close();
  rmSync(home, { recursive: true, force: true });
});

it.each([
  { name: "add_constraint", args: { text: "Use pnpm, not npm" }, kind: "constraint" },
  { name: "decide", args: { summary: "Use TypeScript", rationale: "Type safety" }, kind: "decision" },
])("$name stays in working memory and never writes a file memory", async ({ name, args, kind }) => {
  const config = structuredClone(loadConfig());
  config.memory = { ...config.memory, enabled: true, db_path: join(home, "context.db") };
  config.native.enabled = false;
  config.context_engine.enabled = true;
  config.skills.enabled = false;
  config.session.log_dir = join(home, "sessions");
  model = scriptedMemoryModel(config, [[{ name, args }]]);
  session = await Session.create(home, config);
  await runTurn(session, "Record this constraint or decision", undefined, { sink: {} });
  expect(session.stateGraph.snapshot().some((object) => object.kind === kind)).toBe(true);
  expect(session.eventLog.readAll().some((event) => event.payload.type === "memory_mirror")).toBe(false);
  expect((await session.fileMemory!.list()).entries).toEqual([]);
});
