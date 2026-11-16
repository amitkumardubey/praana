import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { MEMORY_POLICY, type FileMemoryStore } from "../src/file-memory/index.js";
import { executeSlashCommand } from "../src/slash-commands.js";
import { openContextEngineDb } from "../src/context-engine/db.js";
import { maybeAutoCompactClassic } from "../src/auto-compact.js";
import { formatSessionBannerLines, printHelp, SLASH_COMMANDS_HELP_BLOCK } from "../src/app-banner.js";
import { formatTuiBootSummary } from "../src/ui/tui/boot-summary.js";
import { SLASH_COMMAND_METADATA } from "../src/slash-commands.js";

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
  const model = scriptedMemoryModel(config, [
    [{ name: "remember", args: { scope: "global", name: "runtime-observation", type: "user", description: "Keep boundaries clear", body: "Prefer explicit interfaces." } }],
    [{ name: "recall", args: { query: "boundaries" } }],
  ]);
  restore.push(() => model.close());
  const session = await start();
  expect(oldStore).not.toHaveBeenCalled(); // main calls the constructor (caught init failure is not a pass)
  expect(averages).not.toHaveBeenCalled();
  await runTurn(session, "Save and recall this preference", undefined, { sink: {} });
  expect((await maybeAutoCompactClassic(session, 128000, "scripted")).compacted).toBe(false);
  await session.end("clean");
  const db = openContextEngineDb(session.getMemoryDbPath()!);
  db.query("UPDATE scorecard SET validity_avg_start = 0.9, validity_avg_end = 0.8, usefulness_avg_start = 0.7, usefulness_avg_end = 0.6 WHERE session_id = ?").run(session.id);
  db.close();
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
  expect(prompt).toContain('Use recall({ query: "..." }) to search file memories');
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
  expect(prompt).toContain("recall searches cross-session file memories, not the transcript.");
  expect(prompt).toContain(engine
    ? "Neither is recall, which searches cross-session file memories."
    : "Use recall with query or name to read dated cross-session file memories.");
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

it("honors incognito on resume without hiding the rebuilt index", async () => {
  seed();
  const session = await start();
  await session.end("clean");
  const resumed = await Session.resume(session.id, home, config, { incognito: true });
  sessions.push(resumed);
  expect(resumed.isIncognito()).toBe(true);
  expect(resumed.digest).toContain("stable-preference");
  expect(await resumed.fileMemory!.remove({ name: "stable-preference", scope: "global" })).toMatchObject({ ok: false, error: "Incognito mode prevents removal" });
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

it("never installs a Cognitive Memory averages provider in an enabled session", async () => {
  const averages = spyOn(memoryDb, "getMemorySignalAverages");
  restore.push(() => averages.mockRestore());
  const session = await start();
  await session.scorecard.recordMemoryStart(session.getMemoryDbPath()!);
  session.scorecard.persistProgress();
  expect(averages).not.toHaveBeenCalled(); // main installs a provider and samples at start
  await session.end("clean");
  expect(averages).not.toHaveBeenCalled();
});

it("continues with a visible warning when both file memory scopes fail", async () => {
  mkdirSync(join(home, ".praana"), { recursive: true });
  writeFileSync(join(home, ".praana", "memory"), "not a directory");
  writeFileSync(join(home, ".praana", "projects"), "not a directory");
  const session = await start();
  expect(typeof session.memoryError).toBe("string");
  expect(session.memoryError).toContain("Unsafe memory directory");
  expect(session.fileMemory).toBeNull();
  expect(session.digest).toBeNull();
  expect(session.embedder).toBeInstanceOf(DeterministicTestEmbedder);
  expect((await formatSessionBannerLines(session, home, "scripted")).join("\n")).toContain(session.memoryError!);
});

it("keeps deliberate writes from concurrent sessions and lists both on the next startup", async () => {
  const model = scriptedMemoryModel(config, [
    [{ name: "remember", args: { scope: "global", name: "editor-preference", type: "user", description: "Prefer readable editor text", body: "Use readable editor text." } }],
    [{ name: "remember", args: { scope: "global", name: "reference-guide", type: "reference", description: "Consult the official protocol specification", body: "Check the protocol reference before changing wire formats." } }],
  ]);
  restore.push(() => model.close());
  const first = await start();
  const second = await start();
  await Promise.all([
    runTurn(first, "Save this durable editor preference", undefined, { sink: {} }),
    runTurn(second, "Save this reference pointer", undefined, { sink: {} }),
  ]);
  expect(existsSync(join(home, ".praana", "memory", "editor-preference.md"))).toBe(true); // main's registry accepts only the old content/kind shape
  expect(existsSync(join(home, ".praana", "memory", "reference-guide.md"))).toBe(true);
  const next = await start();
  expect(next.digest).toContain("editor-preference");
  expect(next.digest).toContain("reference-guide");
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

const slashHandlers = { setModel() {}, setThinking() {}, getThinking: () => false };

it("keeps file memory unset when incognito toggles after an unreadable memory root", async () => {
  const scopes = [join(home, ".praana", "memory"), join(home, ".praana", "projects")];
  for (const dir of scopes) mkdirSync(dir, { recursive: true });
  for (const dir of scopes) chmodSync(dir, 0);
  try {
    const model = scriptedMemoryModel(config);
    restore.push(() => model.close());
    const session = await start();
    await executeSlashCommand("/incognito on", session, slashHandlers);
    await executeSlashCommand("/incognito off", session, slashHandlers);
    expect(session.memoryEnabled).toBe(false);
    expect(session.fileMemory).toBeNull();
    await runTurn(session, "Hello", undefined, { sink: {} });
    const names = (model.requests[0].tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name);
    expect(names).not.toContain("recall");
    expect(names).not.toContain("remember");
    expect(names).not.toContain("forget_memory");
    const banner = await formatSessionBannerLines(session, home, "scripted");
    expect(banner.filter((line) => line.includes("memory unavailable"))).toHaveLength(1);
    expect(banner.some((line) => line.startsWith("memory db:"))).toBe(false);
  } finally {
    for (const dir of scopes) chmodSync(dir, 0o700);
  }
});

it("keeps the old store and flag when an incognito toggle fails to rebuild", async () => {
  seed();
  const session = await start();
  const originalStore = session.fileMemory;
  const originalCreate = (session as unknown as { createFileMemory: () => FileMemoryStore }).createFileMemory;
  (session as unknown as { createFileMemory: () => FileMemoryStore }).createFileMemory = () => {
    throw new Error("forced constructor failure");
  };
  try {
    const failure = await session.setIncognito(true);
    expect(failure).toContain("forced constructor failure");
    expect(session.isIncognito()).toBe(false);
    expect(session.fileMemory).toBe(originalStore);
    const result = await executeSlashCommand("/incognito on", session, slashHandlers);
    expect(result.lines.join("\n")).toContain("Incognito switch failed: forced constructor failure");
    expect(session.isIncognito()).toBe(false);
    expect(session.fileMemory).toBe(originalStore);
    const recalled = await session.fileMemory!.recall({ query: "boundaries" });
    expect(recalled.ok).toBe(true);
  } finally {
    (session as unknown as { createFileMemory: () => FileMemoryStore }).createFileMemory = originalCreate;
  }
});

const RECALL_GUIDANCE = "recall searches cross-session file memories, not the transcript.";
const CLASSIC_RECALL = "Use recall with query or name to read dated cross-session file memories.";
const INDEX_RECALL = 'Use recall({ query: "..." }) to search file memories';
const ENGINE_RECALL = "Neither is recall, which searches cross-session file memories.";

async function compiledPrompt(engine: boolean, incognito = false): Promise<string> {
  config.context_engine.enabled = engine;
  const model = scriptedMemoryModel(config);
  restore.push(() => model.close());
  const session = await start(incognito);
  await runTurn(session, "Hello", undefined, { sink: {} });
  return String(model.requests[0]?.messages.find((message) => message.role === "system")?.content);
}

function expectNoRecallGuidance(prompt: string): void {
  expect(prompt).not.toContain(RECALL_GUIDANCE);
  expect(prompt).not.toContain(CLASSIC_RECALL);
  expect(prompt).not.toContain(INDEX_RECALL);
  expect(prompt).not.toContain(ENGINE_RECALL);
  expect(prompt).not.toContain("## File Memory");
  expect(prompt).not.toContain(MEMORY_POLICY);
}

it.each([false, true])("omits recall guidance and the save policy when memory is disabled (%s engine)", async (engine) => {
  config.memory.enabled = false;
  expectNoRecallGuidance(await compiledPrompt(engine));
});

it.each([false, true])("omits recall guidance and the save policy when memory init fails (%s engine)", async (engine) => {
  mkdirSync(join(home, ".praana"), { recursive: true });
  writeFileSync(join(home, ".praana", "memory"), "not a directory");
  writeFileSync(join(home, ".praana", "projects"), "not a directory");
  expectNoRecallGuidance(await compiledPrompt(engine));
});

it.each([false, true])("keeps recall guidance and drops the save policy while incognito (%s engine)", async (engine) => {
  seed();
  const prompt = await compiledPrompt(engine, true);
  expect(prompt).toContain(RECALL_GUIDANCE);
  expect(prompt).toContain("# Cross-Session Memory");
  expect(prompt).toContain(INDEX_RECALL);
  expect(prompt).not.toContain("## File Memory");
  expect(prompt).not.toContain(MEMORY_POLICY);
  if (engine) expect(prompt).toContain(ENGINE_RECALL);
  else expect(prompt).toContain(CLASSIC_RECALL);
});

it("describes incognito as blocked writes while a readable store exists", async () => {
  seed();
  const session = await start();
  const on = await executeSlashCommand("/incognito on", session, slashHandlers);
  expect(on.lines.join("\n")).toContain("memory writes are blocked; memories stay readable.");
  expect(on.lines.join("\n")).not.toContain("Cognitive Memory");
  const off = await executeSlashCommand("/incognito off", session, slashHandlers);
  expect(off.lines.join("\n")).toContain("memory writes are allowed.");
  expect(off.lines.join("\n")).not.toContain("Cognitive Memory");
});

it("does not claim memories are readable when incognito has no store", async () => {
  config.memory.enabled = false;
  const session = await start();
  const on = await executeSlashCommand("/incognito on", session, slashHandlers);
  const onText = on.lines.join("\n");
  expect(onText).toContain("memory writes are blocked.");
  expect(onText).not.toContain("readable");
  expect(onText).not.toContain("Cognitive Memory");
  const off = await executeSlashCommand("/incognito off", session, slashHandlers);
  const offText = off.lines.join("\n");
  expect(offText).toContain("memory remains unavailable");
  expect(offText).not.toContain("Cognitive Memory");
});

it("serves digest, recall, memory, stats, and banner counts from the live file store", async () => {
  seed();
  writeFileSync(join(home, ".praana", "memory", "old-note.md"), "---\nname: old-note\ndescription: An old observation\ntype: feedback\nupdated: 2020-01-01\n---\nThis note has gone stale.\n");
  const session = await start();
  const digest = session.digest;
  expect(digest).toContain("stable-preference");

  const shown = await executeSlashCommand("/digest", session, slashHandlers);
  expect(shown.lines.join("\n")).toBe(digest);

  const recalled = await executeSlashCommand("/recall boundaries", session, slashHandlers);
  const recallText = recalled.lines.join("\n");
  expect(recallText).toContain("stable-preference  global  Prefer explicit boundaries");
  expect(recallText).toContain("Keep module boundaries explicit.");

  const listed = await executeSlashCommand("/memory", session, slashHandlers);
  const listText = listed.lines.join("\n");
  expect(listText).toMatch(/stable-preference  global  user  \d+d$/m);
  expect(listText).toMatch(/old-note  global  feedback  \d+d  stale/);
  expect(listText.indexOf("stable-preference")).toBeLessThan(listText.indexOf("old-note"));

  const detail = await executeSlashCommand("/memory show stable-preference", session, slashHandlers);
  expect(detail.lines.join("\n")).toContain("Keep module boundaries explicit.");
  const invalid = await executeSlashCommand("/memory show stable-preference nope", session, slashHandlers);
  expect(invalid.lines.join("\n")).toBe("Invalid scope");

  const pruned = await executeSlashCommand("/memory prune", session, slashHandlers);
  const pruneText = pruned.lines.join("\n");
  expect(pruneText).toContain("Oldest memories (not deleted):");
  expect(pruneText.indexOf("old-note")).toBeLessThan(pruneText.indexOf("stable-preference"));
  expect(existsSync(join(home, ".praana", "memory", "old-note.md"))).toBe(true);
  expect(existsSync(join(home, ".praana", "memory", "stable-preference.md"))).toBe(true);

  const forgotten = await executeSlashCommand("/memory forget old-note global", session, slashHandlers);
  expect(forgotten.lines.join("\n")).toBe("Forgot old-note.");
  expect(existsSync(join(home, ".praana", "memory", "old-note.md"))).toBe(false);

  const deduped = await executeSlashCommand("/memory dedupe", session, slashHandlers);
  const usage = deduped.lines.join("\n");
  expect(usage).toContain("Usage: /memory");
  expect(usage).not.toContain("dedupe");
  const memoryCommand = SLASH_COMMAND_METADATA.find((command) => command.name === "/memory");
  expect(memoryCommand?.argumentHint ?? "").not.toContain("dedupe");
  expect(SLASH_COMMANDS_HELP_BLOCK.join("\n")).not.toContain("/memory dedupe");
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  try { printHelp(); } finally { console.log = orig; }
  const help = logs.join("\n");
  expect(help).toContain("praana memory dedupe");
  expect(help).not.toContain("/memory dedupe");

  const before = await executeSlashCommand("/stats", session, slashHandlers);
  expect(before.lines.join("\n")).toContain("global: 1");
  expect(before.lines.join("\n")).toContain("skipped files: 0");
  expect(before.lines.join("\n")).toContain("prompt index (fixed at session start): 2/2");
  expect(before.lines.join("\n")).not.toContain("Cognitive Memory");
  expect(before.lines.join("\n")).not.toContain("Memory DB");
  expect(before.lines.join("\n")).not.toContain("shown/total");
  const written = await session.fileMemory!.write({
    scope: "global",
    name: "session-note",
    type: "user",
    description: "Noted during the session",
    body: "Counts follow the live store.",
  });
  expect(written.ok).toBe(true);
  const after = await executeSlashCommand("/stats", session, slashHandlers);
  expect(after.lines.join("\n")).toContain("global: 2");
  expect(session.digest).toBe(digest);
  const banner = await formatSessionBannerLines(session, home, "scripted");
  // The banner reflects the start-of-session prompt index, not the live store:
  // the mid-session write cannot change what the model saw at start.
  expect(banner.join("\n")).toContain("shown 2/2");
  expect(banner.some((line) => line.includes("global 2") || line.includes("in db"))).toBe(false);
  expect(banner.some((line) => line.includes("incognito (disabled)") || line === "memory: off")).toBe(false);

  const quiet = await start(true);
  const stats = await executeSlashCommand("/stats", quiet, slashHandlers);
  const statsText = stats.lines.join("\n");
  expect(statsText).toContain("writes: blocked");
  expect(statsText).toContain("global:");
  expect(statsText).not.toContain("memory: off");
  const quietBanner = await formatSessionBannerLines(quiet, home, "scripted");
  expect(quietBanner.join("\n")).toContain("shown 2/2");
  expect(quietBanner.join("\n")).toContain("incognito");
  expect(quietBanner.some((line) => line.includes("incognito (disabled)") || line === "memory: off")).toBe(false);
});

function seedMany(count: number): void {
  const dir = join(home, ".praana", "memory");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const name = `m${String(i).padStart(3, "0")}`;
    writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: Observation ${i}\ntype: user\nupdated: 2026-11-01\n---\nBody ${i}.\n`);
  }
}

function seedOversize(name: string): void {
  const dir = join(home, ".praana", "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), Buffer.alloc(70000, 0x61));
}

it("banner and stats show the capped startup index, not a live rescan", async () => {
  seedMany(300);
  const session = await start();
  const snapshot = session.getMemoryPromptIndex();
  expect(snapshot).not.toBeNull();
  expect(snapshot!.total).toBe(300);
  expect(snapshot!.shown).toBeLessThan(snapshot!.total);
  const banner = await formatSessionBannerLines(session, home, "scripted");
  expect(banner.join("\n")).toContain(`shown ${snapshot!.shown}/${snapshot!.total}`);
  expect(banner.join("\n")).not.toContain("in db");
  const summary = formatTuiBootSummary({ session, model: "scripted", cwd: home, isResume: false });
  expect(summary.join("\n")).toContain(`${snapshot!.total} memories`);
  expect(summary.join("\n")).not.toContain("in db");
  const stats = await executeSlashCommand("/stats", session, slashHandlers);
  expect(stats.lines.join("\n")).toContain(`prompt index (fixed at session start): ${snapshot!.shown}/${snapshot!.total}`);
});

it("never folds unreadable files into the shown/total index counts", async () => {
  seedMany(5);
  seedOversize("corrupt-one");
  seedOversize("corrupt-two");
  const session = await start();
  const banner = await formatSessionBannerLines(session, home, "scripted");
  expect(banner.join("\n")).toContain("shown 5/5");
  expect(banner.join("\n")).not.toContain("5/7");
  const stats = await executeSlashCommand("/stats", session, slashHandlers);
  const statsText = stats.lines.join("\n");
  expect(statsText).toContain("skipped files: 2");
  expect(statsText).toContain("prompt index (fixed at session start): 5/5");
  expect(statsText).not.toContain("5/7");
});

it("says there are no memories yet when the index is empty", async () => {
  const session = await start();
  const digest = await executeSlashCommand("/digest", session, slashHandlers);
  expect(digest.lines.join("\n")).toBe("No memories yet.");
  const listed = await executeSlashCommand("/memory", session, slashHandlers);
  expect(listed.lines.join("\n")).toBe("No memories yet.");
});
