import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Session } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import type { PraanaConfig } from "../src/types.js";
import * as legacy from "../src/memory/index.js";
import * as memoryDb from "../src/memory/db.js";
import * as embedderFactory from "../src/memory/embedder-factory.js";
import * as summarizerFactory from "../src/memory/summarizer-factory.js";
import * as consolidation from "../src/memory/consolidation.js";
import { DeterministicTestEmbedder } from "./helpers/test-embedder.js";
import { computeMemoryStats, runTurn } from "../src/turn.js";
import { scriptedMemoryModel } from "./helpers/scripted-memory-model.js";
import { projectKey } from "../src/file-memory/paths.js";
import { MEMORY_POLICY } from "../src/file-memory/index.js";
import { executeSlashCommand } from "../src/slash-commands.js";

let home: string;
let config: PraanaConfig;
const sessions: Session[] = [];
let restore: (() => void)[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "praana-file-session-"));
  process.env.PRAANA_HOME = home;
  config = structuredClone(loadConfig());
  config.memory = { ...config.memory, enabled: true, summarizer: "disabled", db_path: join(home, "context.db") };
  config.session.log_dir = join(home, "sessions");
  config.skills.enabled = false;
  config.native.enabled = false;
  config.context_engine.enabled = false;
  config.context_engine.measurement_mode = true;
  const embedder = spyOn(embedderFactory, "createEmbedder").mockResolvedValue(new DeterministicTestEmbedder());
  restore.push(() => embedder.mockRestore());
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.end("aborted");
  for (const fn of restore.splice(0).reverse()) fn();
  rmSync(home, { recursive: true, force: true });
});
async function start(incognito = false) {
  const session = await Session.create(home, config, { incognito });
  sessions.push(session);
  return session;
}
function seed(name = "stable-preference") {
  const dir = join(home, ".praana", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: Prefer explicit boundaries\ntype: user\nupdated: 2026-11-01\n---\nKeep module boundaries explicit.\n`);
}

it("owns a file store under the parent of .praana, including in incognito", async () => {
  seed();
  const session = await start(true);
  expect(session.memoryEnabled).toBe(true); // main turns memory off for incognito
  expect(session.fileMemory).not.toBeNull();
  const result = await session.fileMemory!.recall({ query: "boundaries" });
  expect(result.ok).toBe(true);
});

it("constructs no Cognitive Memory store and samples no Cognitive Memory tables at start/resume/end", async () => {
  const oldStore = spyOn(legacy, "MemoryStore").mockImplementation(() => { throw new Error("Cognitive Memory constructor reached"); });
  const averages = spyOn(memoryDb, "getMemorySignalAverages").mockImplementation(() => { throw new Error("Cognitive Memory query reached"); });
  restore.push(() => oldStore.mockRestore(), () => averages.mockRestore());
  const session = await start();
  expect(oldStore).not.toHaveBeenCalled(); // main calls the constructor (caught init failure is not a pass)
  expect(averages).not.toHaveBeenCalled();
  await session.end("clean");
  const resumed = await Session.resume(session.id, home, config);
  sessions.push(resumed);
  await resumed.end("clean");
  expect(oldStore).not.toHaveBeenCalled();
  expect(averages).not.toHaveBeenCalled();
  expect(resumed.scorecard.getMemorySnapshot()).toEqual({ validityAvgStart: 0, validityAvgEnd: 0, usefulnessAvgStart: 0, usefulnessAvgEnd: 0 });
});

it.each([false, true])("injects the seeded startup index through the real %s engine turn", async (engine) => {
  seed();
  config.context_engine.enabled = engine;
  const model = scriptedMemoryModel(config);
  restore.push(() => model.close());
  const session = await start();
  await runTurn(session, "Read the saved observation", undefined, { sink: {} });
  const prompt = String(model.requests[0]?.messages.find((message) => message.role === "system")?.content);
  expect(prompt).toContain("[stable-preference](global/stable-preference.md)"); // main never lists the file store
  expect(prompt).toContain("# Cross-Session Memory");
  expect(prompt).toContain("a memory is an observation at its date");
});

it.each([false, true])("injects no cross-session section for an empty store (%s engine)", async (engine) => {
  config.context_engine.enabled = engine;
  const model = scriptedMemoryModel(config);
  restore.push(() => model.close());
  const session = await start();
  await runTurn(session, "Hello", undefined, { sink: {} });
  const prompt = String(model.requests[0]?.messages.find((message) => message.role === "system")?.content);
  expect(session.digest).toBeNull();
  expect(prompt).not.toContain("# Cross-Session Memory");
  expect(prompt).toContain(MEMORY_POLICY);
});

it("rebuilds the index at resume, not after in-session writes or incognito toggles", async () => {
  seed();
  const session = await start();
  expect(session.digest).toContain("stable-preference");
  seed("second-observation");
  const initial = session.digest;
  await session.setIncognito(true);
  await session.setIncognito(false);
  expect(session.digest).toBe(initial);
  await session.end("clean");
  const resumed = await Session.resume(session.id, home, config);
  sessions.push(resumed);
  expect(resumed.digest).toContain("second-observation");
});

it("keeps global entries and warns once when the project memory scope cannot be read", async () => {
  seed();
  const project = join(home, ".praana", "projects", projectKey(home));
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "memory"), "not a directory");
  const session = await start();
  expect(session.digest).toContain("stable-preference");
  const log = readFileSync(join(config.session.log_dir, session.id, "current.log"), "utf8");
  expect(log.match(/File memory scope skipped/g)).toHaveLength(1);
  expect(log).toContain("project");
});

it("refuses invalid list and index scopes on the session-owned store", async () => {
  const session = await start();
  expect(session.fileMemory).toBeDefined();
  for (const scope of ["", null, false, 0, "elsewhere", Symbol("scope")]) {
    expect(await session.fileMemory!.list({ scope: scope as never })).toMatchObject({ ok: false, error: "Invalid scope" });
    expect(await session.fileMemory!.buildMemoryIndex({ scope: scope as never })).toMatchObject({ ok: false, error: "Invalid scope" });
  }
});

it.each([false, true])("registers strict file-memory schemas on the wire (%s engine)", async (engine) => {
  config.context_engine.enabled = engine;
  const model = scriptedMemoryModel(config, [
    [{ name: "remember", args: { content: "legacy", kind: "fact", mode: "auto" } }],
    [{ name: "recall", args: { query: "boundaries", mode: "auto" } }],
    [{ name: "forget_memory", args: { id: "legacy-id" } }],
  ]);
  restore.push(() => model.close());
  const session = await start();
  await runTurn(session, "Save a stable preference", undefined, { sink: {} });
  const tools = model.requests[0].tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean } } }>;
  for (const [name, fields] of Object.entries({ remember: ["scope", "type", "name", "description", "body"], recall: ["query", "name", "scope"], forget_memory: ["name", "scope"] })) {
    const schema = tools.find((tool) => tool.function.name === name)!.function.parameters;
    expect(Object.keys(schema.properties).sort()).toEqual(fields.sort());
    expect(schema.additionalProperties).toBe(false);
  }
  const results = session.eventLog.readAll().filter((event) => event.kind === "tool_result");
  expect(results).toHaveLength(3);
  for (const event of results) expect(event.payload.result).toMatchObject({ ok: false });
  expect(String(model.requests[0].messages.find((message) => message.role === "system")?.content)).toContain(MEMORY_POLICY);
});

it.each([false, true])("memory.enabled=false removes the index, tools and policy (%s engine)", async (engine) => {
  seed();
  config.memory.enabled = false;
  config.context_engine.enabled = engine;
  const model = scriptedMemoryModel(config);
  restore.push(() => model.close());
  const session = await start();
  await runTurn(session, "Hello", undefined, { sink: {} });
  const request = model.requests[0];
  const names = (request.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
  expect(names).not.toContain("recall"); // main registers old memory tools even when disabled
  expect(names).not.toContain("remember");
  expect(names).not.toContain("forget_memory");
  expect(session.digest).toBeNull();
  expect(String(request.messages.find((message) => message.role === "system")?.content)).not.toContain("# Cross-Session Memory");
  expect(String(request.messages.find((message) => message.role === "system")?.content)).not.toContain(MEMORY_POLICY);
});

it("incognito reads the index and tools but refuses writes/deletes; slash toggle permits writes without rebuilding", async () => {
  seed();
  const memory = { scope: "global", type: "user", name: "terminal-preference", description: "Use readable terminal text", body: "Keep terminal output readable." };
  const model = scriptedMemoryModel(config, [
    [{ name: "remember", args: memory }],
    [{ name: "recall", args: { name: "stable-preference" } }],
    [{ name: "forget_memory", args: { name: "stable-preference", scope: "global" } }],
    [],
    [{ name: "remember", args: memory }],
    [{ name: "recall", args: { query: "terminal" } }],
  ]);
  restore.push(() => model.close());
  const session = await start(true);
  expect(session.digest).toContain("stable-preference"); // main removes the index in incognito
  const initial = session.digest;
  await runTurn(session, "Save this preference and recall the saved observation", undefined, { sink: {} });
  const results = () => session.eventLog.readAll().filter((event) => event.kind === "tool_result").map((event) => event.payload.result);
  expect(results()[0]).toMatchObject({ ok: false, error: "Incognito mode prevents writes" });
  expect(results()[1]).toMatchObject({ ok: true, memory: { name: "stable-preference" } });
  expect(results()[2]).toMatchObject({ ok: false, error: "Incognito mode prevents removal" });
  expect(existsSync(join(home, ".praana", "memory", "terminal-preference.md"))).toBe(false);
  expect(existsSync(join(home, ".praana", "memory", "stable-preference.md"))).toBe(true);
  await executeSlashCommand("/incognito off", session, { setModel() {}, setThinking() {}, getThinking: () => false });
  await runTurn(session, "Now save the preference and recall it", undefined, { sink: {} });
  expect(results()[3]).toMatchObject({ ok: true });
  expect(results()[4]).toMatchObject({ ok: true, matches: [{ name: "terminal-preference" }] });
  expect(readFileSync(join(home, ".praana", "memory", "terminal-preference.md"), "utf8")).toContain("type: user");
  expect(session.digest).toBe(initial);
  expect(session.getRecallUsedCount()).toBe(2);
  expect(computeMemoryStats(session, 0)).toMatchObject({ recallCalls: 2, recallHits: 2 });
});

it("keeps the configured embedder active in real incognito engine scoring", async () => {
  config.context_engine.enabled = true;
  config.context_engine.scoring.w_semantic = 0.3;
  const model = scriptedMemoryModel(config);
  restore.push(() => model.close());
  const session = await start(true);
  expect(session.embedder).toBeInstanceOf(DeterministicTestEmbedder); // main never initializes it in incognito
  const embed = spyOn(session.embedder!, "embed");
  restore.push(() => embed.mockRestore());
  for (let turn = 0; turn < 5; turn++) await runTurn(session, `Inspect module boundaries ${turn}`, undefined, { sink: {} });
  expect(embed).toHaveBeenCalled();
});

it("ends with no automatic memory lifecycle, summarizer, consolidation or artifact promotion", async () => {
  const summarizer = spyOn(summarizerFactory, "createSummarizer");
  const consolidate = spyOn(consolidation, "runConsolidation");
  const sessionEnd = spyOn(legacy.MemoryStore.prototype, "sessionEnd");
  restore.push(() => summarizer.mockRestore(), () => consolidate.mockRestore(), () => sessionEnd.mockRestore());
  config.context_engine.enabled = true;
  config.consolidation.enabled = true;
  config.consolidation.run_delay_seconds = 0;
  const session = await start();
  const artifactPromotion = spyOn(session.contextEngine!, "listHighValueArtifacts");
  restore.push(() => artifactPromotion.mockRestore());
  session.stateGraph.create("note", { text: "A durable but not deliberately saved observation" });
  const status = await session.end("clean", [], { memoryTimeoutMs: 10 });
  expect(status.memory).toBe("noop"); // main runs sessionEnd and returns completed
  expect(summarizer).not.toHaveBeenCalled();
  expect(consolidate).not.toHaveBeenCalled();
  expect(sessionEnd).not.toHaveBeenCalled();
  expect(artifactPromotion).not.toHaveBeenCalled();
  expect(session.eventLog.readAll().some((event) => event.payload.type === "memory_lifecycle")).toBe(false);
});
