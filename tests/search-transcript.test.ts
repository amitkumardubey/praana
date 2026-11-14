import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalWriter, readFullSessionCanonicalRecords, type CanonicalRecord } from "../src/canonical-transcript.js";
import { loadConfig } from "../src/config.js";
import { buildClassicSystemFrame } from "../src/compile-classic.js";
import { buildSystemFrame } from "../src/compiler.js";
import { ContextEngine } from "../src/context-engine/index.js";
import { buildArtifactCard } from "../src/context-engine/summarize.js";
import * as nativeLlm from "../src/llm/index.js";
import type { StreamEvent } from "../src/llm/types.js";
import * as oauth from "../src/oauth.js";
import * as secrets from "../src/redact/secrets.js";
import { Session } from "../src/session.js";
import * as toolRegistry from "../src/tools/index.js";
import { runTurn } from "../src/turn.js";
import { isLoopExempt } from "../src/circuit/loop-gate.js";
import { EventLog } from "../src/event-log.js";
import { StateGraph } from "../src/state-graph.js";
import { summarizeArgs } from "../src/tool-summary.js";
import { createAllTools, describeTools } from "../src/tools/index.js";
import * as searchTranscriptModule from "../src/tools/search-transcript.js";
import { toolIcon } from "../src/ui/tui/tool-icons.js";

const api = async () => searchTranscriptModule;

const roots: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  mock.restore();
  for (const log of logs.splice(0)) log.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function openLog(sessionId = "sess-pr3") {
  const root = mkdtempSync(join(tmpdir(), "praana-search-transcript-"));
  roots.push(root);
  const log = new EventLog(sessionId, root);
  logs.push(log);
  return { root, log, sessionId };
}

function addCanonical(log: EventLog, id: string, record: CanonicalRecord): void {
  log.append({
    event_id: id,
    kind: "canonical_message",
    actor: "kernel",
    payload: { ...record },
  });
}

async function writeCanonicalToolResult(log: EventLog, tool: string, toolCallId: string, promptResultText: string): Promise<string> {
  const writer = new CanonicalWriter(log, (error) => { throw error; });
  const turnId = await writer.startTurn("Inspect output");
  await writer.assistant(turnId, {
    role: "assistant", content: "", toolCalls: [{ id: toolCallId, name: tool, args: {} }],
  });
  await writer.result(turnId, toolCallId, tool, promptResultText, false);
  return log.readAll({ includeCanonical: true }).at(-1)!.event_id;
}

function addCompactionBoundary(log: EventLog, id: string, generation: number, boundaryEventId: string): void {
  log.append({
    event_id: id,
    kind: "system_note",
    actor: "kernel",
    payload: {
      type: "compaction_boundary",
      generation,
      boundaryEventId,
    },
  });
}

function addResetBoundary(log: EventLog, id: string): void {
  log.append({
    event_id: id,
    kind: "system_note",
    actor: "kernel",
    payload: {
      type: "reset_boundary",
      command: "/clear",
    },
  });
}

describe("search_transcript tool (PR3)", () => {
  test.each(["includeCanonical", "includeInternal"] as const)("requests unfiltered canonical events with the %s reader API", async (option) => {
    const { log } = openLog();
    addCanonical(log, "raw-message", {
      formatVersion: 1,
      kind: "user_input",
      turnId: 1,
      message: { text: "raw canonical needle" },
    });
    const rawOptions = { includeCanonical: true, includeInternal: true };
    const events = log.readAll(rawOptions);
    const reader = {
      readAll: (options?: { includeCanonical?: boolean; includeInternal?: boolean }) =>
        options?.[option] ? events : events.filter((event) => event.kind !== "canonical_message"),
    };
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: reader }).search_transcript;
    const result = await tool.execute({ query: "needle" });
    if (!result.ok || result.mode !== "search") throw new Error("Expected search");
    expect(result.matches.map((match) => match.id)).toEqual(["raw-message"]);
  });

  test.each([{ query: "legacy needle" }, { id: "legacy-user" }])("directs legacy-only sessions to search_session_log for %j", async (args) => {
    const { log } = openLog();
    log.append({ event_id: "legacy-user", kind: "user_message", actor: "user", payload: { text: "legacy needle" } });
    log.append({ kind: "tool_result", actor: "tool", payload: { tool: "shell", toolCallId: "legacy-call", result: "legacy needle" } });
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const result = await tool.execute(args);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected unavailable transcript");
    expect(result.error).toMatch(/canonical transcript is not available for this session/i);
    expect(result.error).toContain("search_session_log");
  });

  test.each([{ query: "malformed needle" }, { id: "malformed-user" }])("directs malformed-only canonical transcripts to search_session_log for %j", async (args) => {
    const { log: source } = openLog("source");
    const writer = new CanonicalWriter(source, (error) => { throw error; });
    await writer.startTurn("malformed needle");
    const record = readFullSessionCanonicalRecords(source.readAll({ includeCanonical: true }))[0]!;
    const { log } = openLog();
    for (const payload of [{ ...record, formatVersion: 999 }, { ...record, message: { text: 42 } }]) {
      log.append({ kind: "canonical_message", actor: "kernel", payload });
    }
    log.append({ event_id: "malformed-user", kind: "user_message", actor: "user", payload: { text: "malformed needle" } });
    const indexed = searchTranscriptModule.indexSessionTranscript(log);
    expect(indexed.entries).toEqual([]);
    expect(indexed.canonicalTranscriptAvailable).toBe(false);
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const result = await tool.execute(args);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected unavailable transcript");
    expect(result.error).toMatch(/canonical transcript is not available for this session/i);
    expect(result.error).toContain("search_session_log");
  });

  test("does not search its own calls or results but still fetches them by id", async () => {
    const { log } = openLog();
    addCanonical(log, "user-needle", {
      formatVersion: 1,
      kind: "user_input",
      turnId: 1,
      message: { text: "needle" },
    });
    for (const id of ["earlier-search", "in-flight-search"]) {
      addCanonical(log, id, {
        formatVersion: 1,
        kind: "assistant",
        turnId: 1,
        message: { text: "", toolCalls: [{ id, name: "search_transcript", args: { query: "needle" } }] },
      });
    }
    addCanonical(log, "search-result", {
      formatVersion: 1,
      kind: "tool_result",
      turnId: 1,
      message: { callId: "earlier-search", toolName: "search_transcript", text: "needle", isError: false },
    });
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const result = await tool.execute({ query: "needle" });
    if (!result.ok || result.mode !== "search") throw new Error("Expected search");
    expect(result.matches.map((m) => m.id)).toEqual(["user-needle"]);
    for (const id of ["earlier-search", "in-flight-search", "search-result"]) {
      const fetched = await tool.execute({ id });
      if (!fetched.ok || fetched.mode !== "fetch") throw new Error("Expected fetch");
      expect(fetched.message.content).toContain("needle");
    }
  });

  test("indexes a single search eligibility flag without stripping self-call text", () => {
    const { log } = openLog();
    const records: [string, CanonicalRecord, boolean][] = [
      ["user", { formatVersion: 1, kind: "user_input", turnId: 1, message: { text: "search_transcript needle" } }, true],
      ["chat", { formatVersion: 1, kind: "assistant", turnId: 1, message: { text: "needle" } }, true],
      ["call", {
        formatVersion: 1, kind: "assistant", turnId: 1,
        message: { text: "", toolCalls: [{ id: "search-call", name: "search_transcript", args: { query: "needle" } }] },
      }, false],
      ["result", {
        formatVersion: 1, kind: "tool_result", turnId: 1,
        message: { callId: "search-call", toolName: "search_transcript", text: "needle", isError: false },
      }, false],
      ["shell", {
        formatVersion: 1, kind: "tool_result", turnId: 1,
        message: { callId: "shell-call", toolName: "shell", text: "search_transcript needle", isError: false },
      }, true],
    ];
    for (const [id, record] of records) addCanonical(log, id, record);
    const entries = searchTranscriptModule.indexSessionTranscript(log).entries;
    expect(entries).toHaveLength(records.length);
    for (const [index, [, , searchable]] of records.entries()) {
      expect(entries[index]).toHaveProperty("searchable", searchable);
      expect(entries[index]!.searchText).toContain("needle");
      expect(entries[index]!.searchText).toContain(entries[index]!.text);
    }
  });

  test("excludes complete assistant messages calling search_transcript but still fetches them", async () => {
    const { log } = openLog();
    addCanonical(log, "user", { formatVersion: 1, kind: "user_input", turnId: 1, message: { text: "needle" } });
    addCanonical(log, "mixed-call", {
      formatVersion: 1, kind: "assistant", turnId: 1,
      message: {
        text: "narration needle",
        thinking: "thinking needle",
        toolCalls: [
          { id: "search", name: "search_transcript", args: { query: "search needle" } },
          { id: "shell", name: "shell", args: { command: "echo shell needle" } },
        ],
      },
    });
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const search = await tool.execute({ query: "needle" });
    if (!search.ok || search.mode !== "search") throw new Error("Expected search");
    expect(search.matches.map((match) => match.id)).toEqual(["user"]);
    const fetched = await tool.execute({ id: "mixed-call" });
    if (!fetched.ok || fetched.mode !== "fetch") throw new Error("Expected fetch");
    for (const text of ["narration needle", "thinking needle", "search needle", "shell needle"]) {
      expect(fetched.message.content).toContain(text);
    }
  });

  test("ranks artifact cards and elided stubs below original content while retaining artifact ids", async () => {
    const { log } = openLog();
    const artifactId = "art_abcdef123456";
    const texts = [
      ["original", `needle ${"ordinary output ".repeat(200)}`],
      ["card", `[artifact: ${artifactId} | shell: needle | 1,000 tokens raw]\nRetrieve: retrieve_artifact("${artifactId}")`],
      ["stub", `needle\n... [elided 80 lines / 3200 bytes; full output stored in artifact ${artifactId} — call retrieve_artifact("${artifactId}") to inspect] ...`],
    ] as const;
    for (const [id, text] of texts) {
      addCanonical(log, id, {
        formatVersion: 1,
        kind: "tool_result",
        turnId: 1,
        message: { callId: id, toolName: "shell", text, isError: false },
      });
    }
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const result = await tool.execute({ query: "needle" });
    if (!result.ok || result.mode !== "search") throw new Error("Expected search");
    expect(result.matches[0]?.id).toBe("original");
    expect(result.matches).toHaveLength(3);
    for (const id of ["card", "stub"]) {
      expect(result.matches.find((m) => m.id === id)?.artifactId).toBe(artifactId);
    }
    const limited = await tool.execute({ query: "needle", limit: 1 });
    if (!limited.ok || limited.mode !== "search") throw new Error("Expected search");
    expect(limited.matches[0]?.id).toBe("original");
  });

  test("keeps a strongly matching artifact card ahead of weak partial matches", async () => {
    const { log } = openLog();
    addCanonical(log, "best-card", {
      formatVersion: 1,
      kind: "tool_result",
      turnId: 1,
      message: {
        callId: "card-call",
        toolName: "shell",
        text: buildArtifactCard("art_best", "shell", "cobalt migration failure", 1000),
        isError: false,
      },
    });
    for (let i = 0; i < 12; i++) {
      addCanonical(log, `weak-${i}`, {
        formatVersion: 1,
        kind: "user_input",
        turnId: 1,
        message: { text: `cobalt ${"unrelated padding ".repeat(20)}` },
      });
    }
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const result = await tool.execute({ query: "cobalt migration failure", limit: 1 });
    if (!result.ok || result.mode !== "search") throw new Error("Expected search");
    expect(result.matches.map((match) => match.id)).toEqual(["best-card"]);
    const byArtifact = await tool.execute({ query: "art_best", limit: 1 });
    if (!byArtifact.ok || byArtifact.mode !== "search") throw new Error("Expected search");
    expect(byArtifact.matches.map((match) => match.id)).toEqual(["best-card"]);
  });

  test("does not demote user text that quotes an artifact card", async () => {
    const { log } = openLog();
    for (const [id, text] of [
      ["quoted", "needle [artifact: art_x"],
      ["longer", `needle ${"ordinary output ".repeat(200)}`],
    ]) {
      addCanonical(log, id!, {
        formatVersion: 1,
        kind: "user_input",
        turnId: 1,
        message: { text: text! },
      });
    }
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const result = await tool.execute({ query: "needle", limit: 1 });
    if (!result.ok || result.mode !== "search") throw new Error("Expected search");
    expect(result.matches.map((match) => match.id)).toEqual(["quoted"]);
  });

  test.each([
    ["shell", "src/card.ts:16: const marker = '[artifact: art_mentioned';"],
    ["read_file", 'The output format uses [artifact: art_mentioned | tool | tokens raw].\nThis is documentation, not a stub.'],
    ["read_file", `Example card:\n\`\`\`text\n${buildArtifactCard("art_mentioned", "shell", "inspect", 1000)}\n\`\`\``],
    ["shell", 'docs/format.md:20: full output stored in artifact art_mentioned'],
  ])("does not classify %s output mentioning artifact syntax as a stub: %s", async (tool, promptResultText) => {
    const { log } = openLog();
    const id = await writeCanonicalToolResult(log, tool!, "mention", promptResultText!);
    const entry = searchTranscriptModule.indexSessionTranscript(log).entries.find((entry) => entry.id === id)!;
    expect(entry.artifactId).toBe("art_mentioned");
    expect(entry.unrecoveredStub).toBe(false);
    expect(entry.text).toBe(promptResultText!);
  });

  test.each([
    buildArtifactCard("art_stub", "shell", "inspect", 1000),
    'head\n... [elided 80 lines / 3200 bytes; full output stored in artifact art_stub — call retrieve_artifact("art_stub") to inspect] ...',
  ])("classifies only canonical artifact cards and elided stubs as unrecovered: %s", async (promptResultText) => {
    const { log } = openLog();
    const id = await writeCanonicalToolResult(log, "shell", "stub", promptResultText);
    const entry = searchTranscriptModule.indexSessionTranscript(log).entries.find((entry) => entry.id === id)!;
    expect(entry.artifactId).toBe("art_stub");
    expect(entry.unrecoveredStub).toBe(true);
    expect(searchTranscriptModule.indexSessionTranscript(log).entries.filter((entry) => entry.kind !== "tool_result")
      .every((entry) => !entry.unrecoveredStub)).toBe(true);
  });

  test.each([
    buildArtifactCard("art_quoted", "shell", "inspect", 1000),
    { ok: true, content: 'Document quoting [artifact: art_quoted and full output stored in artifact art_quoted' },
  ])("never marks recovered output as a stub even when it contains artifact syntax: %j", async (result) => {
    const { log } = openLog();
    const tool = "echo";
    const toolCallId = "recovered";
    const id = await writeCanonicalToolResult(log, tool, toolCallId, buildArtifactCard("art_source", tool, "inspect", 1000));
    log.append({ kind: "tool_result", actor: "tool", payload: { toolCallId, tool, result } });
    const entry = searchTranscriptModule.indexSessionTranscript(log).entries.find((entry) => entry.id === id)!;
    expect(entry.text).toBe(typeof result === "string" ? result : JSON.stringify(result));
    expect(entry.artifactId).toBe("art_source");
    expect(entry.unrecoveredStub).toBe(false);
  });

  test("keeps recovered source output ahead of later cards for the same artifact", async () => {
    const { log } = openLog();
    const card = buildArtifactCard("art_abcdef123456", "read_file", "needle.txt", 1000);
    for (const id of ["source", "repeat"]) {
      addCanonical(log, id, {
        formatVersion: 1,
        kind: "tool_result",
        turnId: 1,
        message: { callId: id, toolName: "read_file", text: card, isError: false },
      });
      log.append({
        kind: "tool_result",
        actor: "tool",
        payload: {
          toolCallId: id,
          tool: "read_file",
          result: id === "source"
            ? { ok: true, content: `needle.txt ${"ordinary output ".repeat(200)}` }
            : {
              ok: true, content: card, artifact_id: "art_abcdef123456", original_turn: 1,
              warning: 'Already read turn 1 — use retrieve_artifact("art_abcdef123456") or search_turn_events',
              skipped_disk: true,
            },
        },
      });
    }
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const result = await tool.execute({ query: "needle.txt", limit: 1 });
    if (!result.ok || result.mode !== "search") throw new Error("Expected search");
    expect(result.matches[0]?.id).toBe("source");
    expect(result.matches[0]?.artifactId).toBe("art_abcdef123456");
  });

  test("redacts each entry exactly once per run, including recovered output", async () => {
    const { log } = openLog();
    const token = `ghp_${"Z".repeat(40)}`;
    const records: CanonicalRecord[] = [
      { formatVersion: 1, kind: "user_input", turnId: 1, message: { text: `needle ${token}` } },
      {
        formatVersion: 1, kind: "assistant", turnId: 1,
        message: { text: "needle", thinking: token, toolCalls: [{ id: "call", name: "shell", args: { command: `echo ${token}` } }] },
      },
      {
        formatVersion: 1, kind: "tool_result", turnId: 1,
        message: { callId: "call", toolName: "shell", text: buildArtifactCard("art_redact", "shell", "inspect", 1000), isError: false },
      },
      { formatVersion: 1, kind: "notice", turnId: 1, message: { text: `needle ${token}` } },
    ];
    records.forEach((record, i) => addCanonical(log, `redact-${i}`, record));
    log.append({
      kind: "tool_result", actor: "tool",
      payload: { toolCallId: "call", tool: "shell", result: `needle ${token}` },
    });
    const originalRedact = secrets.redactSecrets;
    const redact = spyOn(secrets, "redactSecrets").mockImplementation((value) => originalRedact(value));
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    for (const args of [{ query: "needle" }, { id: "redact-2", context_messages: 1 }]) {
      redact.mockClear();
      const result = await tool.execute(args);
      expect(result.ok).toBe(true);
      expect(redact).toHaveBeenCalledTimes(records.length);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result)).toContain("[REDACTED:github-token]");
    }
  });

  test("redacts complete tokens before either edge of a search snippet is sliced", async () => {
    const { log } = openLog();
    const token = `ghp_${"Z".repeat(40)}`;
    const texts = [
      `needle ${" ".repeat(283)}${token} ${"padding ".repeat(60)}`,
      `${" ".repeat(140)}${token}${" ".repeat(116)}needle ${"padding ".repeat(60)}`,
    ];
    for (const [i, text] of texts.entries()) {
      addCanonical(log, `secret-${i}`, {
        formatVersion: 1,
        kind: "user_input",
        turnId: i + 1,
        message: { text },
      });
    }
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const result = await tool.execute({ query: "needle" });
    if (!result.ok || result.mode !== "search") throw new Error("Expected search");
    expect(result.matches).toHaveLength(2);
    for (const match of result.matches) {
      expect(match.snippet).not.toContain("Z".repeat(8));
      expect(match.snippet).not.toContain("ghp_");
    }
  });

  test("redacts full fetch and neighbor texts before truncating them", async () => {
    const { log } = openLog();
    const token = `ghp_${"Z".repeat(40)}`;
    for (const [id, padding] of [["before", 190], ["target", 90], ["after", 190]] as const) {
      addCanonical(log, id, {
        formatVersion: 1,
        kind: "assistant",
        turnId: 1,
        message: { text: `${" ".repeat(padding)}${token} trailing text` },
      });
    }
    const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const result = await tool.execute({ id: "target", max_chars: 100, context_messages: 1 });
    if (!result.ok || result.mode !== "fetch") throw new Error("Expected fetch");
    expect(result.message.content).not.toContain("ghp_");
    expect(result.message.before).toHaveLength(1);
    expect(result.message.after).toHaveLength(1);
    for (const neighbor of [...result.message.before!, ...result.message.after!]) {
      expect(neighbor.preview).not.toContain("ghp_");
    }
    const full = await tool.execute({ id: "target" });
    if (!full.ok || full.mode !== "fetch") throw new Error("Expected fetch");
    expect(full.message.content).toContain("[REDACTED:github-token]");
    expect(full.message.totalChars).toBe(full.message.content.length);
  });

  test("recovers raw engine output behind an artifact card after reload", async () => {
    const { root, log, sessionId } = openLog();
    log.close();
    const config = loadConfig();
    config.session.log_dir = root;
    config.memory.enabled = false;
    config.native = { ...config.native!, enabled: false };
    config.llm = { provider: "openrouter", model: "test/model" };
    config.context_engine = { ...config.context_engine!, enabled: true, artifact_inline_threshold: 1 };
    const session = Session.createNew(sessionId, root, config);
    logs.push(session.eventLog);
    const engine = ContextEngine.open(":memory:", sessionId, config.context_engine);
    session.contextEngine = engine;
    session.headless = true;
    const needle = "ENGINE_OUTPUT_NEEDLE_7319";
    const raw = { ok: true, content: `${"ordinary output ".repeat(200)}${needle}` };
    spyOn(session, "ensureModelContextWindow").mockResolvedValue(128000);
    spyOn(oauth, "resolveOAuthModelAuth").mockResolvedValue(null);
    spyOn(toolRegistry, "createAllTools").mockReturnValue({
      echo: { description: "echo", parameters: {}, execute: async () => raw },
    } as unknown as ReturnType<typeof createAllTools>);
    let step = 0;
    spyOn(nativeLlm, "streamLlmResponse").mockImplementation(() => (async function* (): AsyncGenerator<StreamEvent> {
      if (step++ === 0) {
        const call = { id: "engine-call", name: "echo", args: {} };
        yield { type: "tool_call_end", toolCall: call };
        yield { type: "done", reason: "tool_use", message: { role: "assistant", content: "", toolCalls: [call] } };
      } else {
        yield { type: "text_delta", delta: "done" };
        yield { type: "done", reason: "stop", message: { role: "assistant", content: "done" } };
      }
    })());
    try {
      await runTurn(session, "inspect output", undefined, { sink: {} });
      const rawOptions = { includeCanonical: true, includeInternal: true };
      const records = readFullSessionCanonicalRecords(session.eventLog.readAll(rawOptions));
      const result = records.find((r) => r.kind === "tool_result");
      expect(result?.message.text).toContain("[artifact:");
      expect(result?.message.text).not.toContain(needle);
      expect(session.eventLog.readAll().find((e) => e.kind === "tool_result")?.payload.result).toEqual(raw);
      session.eventLog.close();
      const reloaded = new EventLog(sessionId, root);
      logs.push(reloaded);
      const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: reloaded }).search_transcript;
      const search = await tool.execute({ query: needle });
      if (!search.ok || search.mode !== "search") throw new Error("Expected search");
      expect(search.matches).toHaveLength(1);
      const indexed = searchTranscriptModule.indexSessionTranscript(reloaded).entries;
      const entry = indexed.find((entry) => entry.kind === "tool_result")!;
      const fetched = await tool.execute({ id: entry.id });
      if (!fetched.ok || fetched.mode !== "fetch") throw new Error("Expected fetch");
      expect(fetched.message.artifactId).toMatch(/^art_/);
      expect(search.matches[0]?.id).toBe(entry.id);
      expect(fetched.message.content).toBe(JSON.stringify(raw));
    } finally {
      engine.close();
    }
  });

  test("leaves both artifact entries unchanged when a call id is reused before pairing", async () => {
    const { log } = openLog();
    const card = buildArtifactCard("art_shared", "shell", "inspect", 1000);
    for (const id of ["first", "second"]) {
      addCanonical(log, id, {
        formatVersion: 1,
        kind: "tool_result",
        turnId: 1,
        message: { callId: "reused", toolName: "shell", text: card, isError: false },
      });
    }
    log.append({
      kind: "tool_result",
      actor: "tool",
      payload: { toolCallId: "reused", tool: "shell", result: "unrelated needle" },
    });
    const entries = searchTranscriptModule.indexSessionTranscript(log).entries;
    expect(entries.map((entry) => entry.text)).toEqual([card, card]);
  });

  test("keeps an empty-call-id entry unchanged instead of pairing or dropping it", async () => {
    const { log } = openLog();
    const card = buildArtifactCard("art_missing", "shell", "inspect", 1000);
    addCanonical(log, "missing-call", {
      formatVersion: 1,
      kind: "tool_result",
      turnId: 1,
      message: { callId: "", toolName: "shell", text: card, isError: false },
    });
    log.append({
      kind: "tool_result",
      actor: "tool",
      payload: { toolCallId: "", tool: "shell", result: "unrelated needle" },
    });
    const entries = searchTranscriptModule.indexSessionTranscript(log).entries;
    expect(entries.map((entry) => ({ id: entry.id, callId: entry.callId, text: entry.text })))
      .toEqual([{ id: "missing-call", callId: "", text: card }]);
  });

  test.each(["raw string needle", { ok: true, content: "raw object needle" }])("recovers raw paired output without an artifact id: %j", async (result) => {
    const { log } = openLog();
    const tool = "echo";
    const toolCallId = "call";
    const artifactId = "art_expected";
    const promptResultText = buildArtifactCard(artifactId, tool, "inspect", 1000);
    const id = await writeCanonicalToolResult(log, tool, toolCallId, promptResultText);
    log.append({ kind: "tool_result", actor: "tool", payload: { toolCallId, tool, result } });
    const entry = searchTranscriptModule.indexSessionTranscript(log).entries.find((entry) => entry.id === id)!;
    const text = typeof result === "string" ? result : JSON.stringify(result);
    expect(entry.text).toBe(text);
    expect(entry.artifactId).toBe(artifactId);
    expect(entry.unrecoveredStub).toBe(false);
    const searchTool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
    const search = await searchTool.execute({ query: "needle" });
    if (!search.ok || search.mode !== "search") throw new Error("Expected search");
    expect(search.matches.map((match) => match.id)).toEqual([id]);
    const fetched = await searchTool.execute({ id });
    if (!fetched.ok || fetched.mode !== "fetch") throw new Error("Expected fetch");
    expect(fetched.message.content).toBe(text);
    expect(fetched.message.artifactId).toBe(artifactId);
  });

  test("never pairs retrieve_artifact results", async () => {
    const { log } = openLog();
    const tool = "retrieve_artifact";
    const toolCallId = "retrieve";
    const card = buildArtifactCard("art_retrieved", "read_file", "inspect", 1000);
    const id = await writeCanonicalToolResult(log, tool, toolCallId, card);
    const result = { ok: true, id: "art_retrieved", content: card };
    log.append({ kind: "tool_result", actor: "tool", payload: { toolCallId, tool, result } });
    const entry = searchTranscriptModule.indexSessionTranscript(log).entries.find((entry) => entry.id === id)!;
    expect(entry.text).toBe(card);
    expect(entry.unrecoveredStub).toBe(false);
  });

  test("only recovers paired source results within the same reset epoch", async () => {
    for (const scenario of ["wrong-tool", "wrong-call", "repeat-read", "reset"] as const) {
      const { log } = openLog();
      const card = buildArtifactCard("art_abcdef123456", "read_file", "inspect", 1000);
      addCanonical(log, "card", {
        formatVersion: 1,
        kind: "tool_result",
        turnId: 1,
        message: { callId: "call", toolName: "read_file", text: card, isError: false },
      });
      if (scenario === "reset") addResetBoundary(log, "reset");
      log.append({
        kind: "tool_result",
        actor: "tool",
        payload: {
          toolCallId: scenario === "wrong-call" ? "other" : "call",
          tool: scenario === "wrong-tool" ? "shell" : "read_file",
          result: scenario === "repeat-read"
            ? {
              ok: true, content: card, artifact_id: "art_abcdef123456", original_turn: 1,
              warning: 'Already read turn 1 — use retrieve_artifact("art_abcdef123456") or search_turn_events',
              skipped_disk: true,
            }
            : { ok: true, content: "unrelated needle" },
        },
      });
      const tool = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript;
      const fetched = await tool.execute({ id: "card", include_previous_resets: true });
      if (!fetched.ok || fetched.mode !== "fetch") throw new Error("Expected fetch");
      expect(fetched.message.content).toBe(card);
      const search = await tool.execute({ query: "needle", include_previous_resets: true });
      if (!search.ok || search.mode !== "search") throw new Error("Expected search");
      expect(search.matches).toEqual([]);
    }
  });

  test("recovers a unique fact folded across two compactions and after session reload", async () => {
    const { createSearchTranscriptTool } = await api();
    const { root, log, sessionId } = openLog();

    // Turn 1: contains a unique fact that will be folded by compaction 1
    addCanonical(log, "msg-u1", {
      formatVersion: 1,
      kind: "user_input",
      turnId: 1,
      message: { text: "Investigate the database port and token." },
    });
    addCanonical(log, "msg-a1", {
      formatVersion: 1,
      kind: "assistant",
      turnId: 1,
      message: {
        text: "Checking config",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "config.toml" } }],
      },
    });
    addCanonical(log, "msg-r1", {
      formatVersion: 1,
      kind: "tool_result",
      turnId: 1,
      message: {
        callId: "c1",
        toolName: "read_file",
        text: "DB_PORT=15432\nUNIQUE_FACT_OMEGA_98765=enabled_strict_wal_mode",
        isError: false,
      },
    });
    addCanonical(log, "msg-a1-final", {
      formatVersion: 1,
      kind: "assistant",
      turnId: 1,
      message: { text: "Found DB_PORT 15432." },
    });

    // Compaction 1 folds turn 1
    addCompactionBoundary(log, "compact-1", 1, "msg-a1-final");

    // Turn 2: later folded by compaction 2
    addCanonical(log, "msg-u2", {
      formatVersion: 1,
      kind: "user_input",
      turnId: 2,
      message: { text: "Now check Redis timeout." },
    });
    addCanonical(log, "msg-a2-final", {
      formatVersion: 1,
      kind: "assistant",
      turnId: 2,
      message: { text: "Redis timeout is 5000ms." },
    });

    // Compaction 2 folds turn 2
    addCompactionBoundary(log, "compact-2", 2, "msg-a2-final");

    // Turn 3: active tail
    addCanonical(log, "msg-u3", {
      formatVersion: 1,
      kind: "user_input",
      turnId: 3,
      message: { text: "Summarize everything." },
    });

    const { search_transcript } = createSearchTranscriptTool({ eventLog: log });
    const searchRes = await search_transcript.execute({
      query: "UNIQUE_FACT_OMEGA_98765",
    });

    expect(searchRes.ok).toBe(true);
    if (!searchRes.ok || !("matches" in searchRes)) throw new Error("Expected matches");
    expect(searchRes.matches.length).toBeGreaterThanOrEqual(1);
    expect(searchRes.matches[0]?.id).toBe("msg-r1");
    expect(searchRes.matches[0]?.resetEpoch).toBe("session_start");
    expect(searchRes.matches[0]?.snippet).toContain("UNIQUE_FACT_OMEGA_98765=enabled_strict_wal_mode");

    // Close and reload the session EventLog from disk (simulating session reload / resume)
    log.close();
    const reloadedLog = new EventLog(sessionId, root);
    logs.push(reloadedLog);
    const reloadedTool = createSearchTranscriptTool({ eventLog: reloadedLog }).search_transcript;

    const afterReload = await reloadedTool.execute({
      query: "enabled_strict_wal_mode",
    });
    expect(afterReload.ok).toBe(true);
    if (!afterReload.ok || !("matches" in afterReload)) throw new Error("Expected matches after reload");
    expect(afterReload.matches[0]?.id).toBe("msg-r1");
    expect(afterReload.matches[0]?.snippet).toContain("UNIQUE_FACT_OMEGA_98765");
  });

  test("hides pre-/clear messages by default and returns them only with include_previous_resets=true", async () => {
    const { createSearchTranscriptTool } = await api();
    const { log } = openLog();

    addCanonical(log, "pre-clear-msg", {
      formatVersion: 1,
      kind: "user_input",
      turnId: 1,
      message: { text: "PRE_CLEAR_SECRET_CODEWORD_COBALT_42" },
    });

    addResetBoundary(log, "reset-epoch-1");

    addCanonical(log, "post-clear-msg", {
      formatVersion: 1,
      kind: "user_input",
      turnId: 2,
      message: { text: "POST_CLEAR_ACTIVE_TOPIC_EMERALD_99" },
    });

    const { search_transcript } = createSearchTranscriptTool({ eventLog: log });

    // Default search only searches current reset_epoch ("reset-epoch-1")
    const defaultSearch = await search_transcript.execute({
      query: "PRE_CLEAR_SECRET_CODEWORD_COBALT_42",
    });
    expect(defaultSearch.ok).toBe(true);
    if (!defaultSearch.ok || !("matches" in defaultSearch)) throw new Error("Expected search result");
    expect(defaultSearch.matches).toEqual([]);
    expect(defaultSearch.resetEpoch).toBe("reset-epoch-1");

    // Default fetch by ID of a pre-clear message is also refused without include_previous_resets=true
    const defaultFetch = await search_transcript.execute({
      id: "pre-clear-msg",
    });
    expect(defaultFetch.ok).toBe(false);
    if (!defaultFetch.ok) {
      expect(defaultFetch.error).toContain("include_previous_resets");
    }

    // Opt-in cross-reset search finds the pre-clear message and reports its resetEpoch
    const crossResetSearch = await search_transcript.execute({
      query: "PRE_CLEAR_SECRET_CODEWORD_COBALT_42",
      include_previous_resets: true,
    });
    expect(crossResetSearch.ok).toBe(true);
    if (!crossResetSearch.ok || !("matches" in crossResetSearch)) throw new Error("Expected matches");
    expect(crossResetSearch.matches).toHaveLength(1);
    expect(crossResetSearch.matches[0]?.id).toBe("pre-clear-msg");
    expect(crossResetSearch.matches[0]?.resetEpoch).toBe("session_start");

    // Opt-in cross-reset fetch by ID succeeds
    const crossResetFetch = await search_transcript.execute({
      id: "pre-clear-msg",
      include_previous_resets: true,
    });
    expect(crossResetFetch.ok).toBe(true);
    if (!crossResetFetch.ok || !("message" in crossResetFetch)) throw new Error("Expected message");
    expect(crossResetFetch.message.id).toBe("pre-clear-msg");
    expect(crossResetFetch.message.resetEpoch).toBe("session_start");
    expect(crossResetFetch.message.content).toContain("PRE_CLEAR_SECRET_CODEWORD_COBALT_42");
  });

  test("stubbed messages remain searchable and fetchable with bounded snippets, full content retrieval, and surrounding context", async () => {
    const { createSearchTranscriptTool } = await api();
    const { log } = openLog();

    addCanonical(log, "u-1", {
      formatVersion: 1,
      kind: "user_input",
      turnId: 1,
      message: { text: "Run the full test suite" },
    });
    addCanonical(log, "a-1", {
      formatVersion: 1,
      kind: "assistant",
      turnId: 1,
      message: {
        text: "Executing bun test",
        toolCalls: [{ id: "tc-1", name: "shell", args: { command: "bun test" } }],
      },
    });

    const longLines = Array.from(
      { length: 120 },
      (_, i) => `line-${i + 1}: ${i === 60 ? "STUBBED_FINDING_NEEDLE_XYZ in module foo/bar.ts:144" : "padding_output_token ".repeat(6)}`,
    ).join("\n") + '\n... [elided 80 lines / 3200 bytes; full output stored in artifact art_deadbeef1234 — call retrieve_artifact("art_deadbeef1234") to inspect] ...';

    addCanonical(log, "res-stubbed-1", {
      formatVersion: 1,
      kind: "tool_result",
      turnId: 1,
      message: {
        callId: "tc-1",
        toolName: "shell",
        text: longLines,
        isError: true,
      },
    });
    addCanonical(log, "a-2", {
      formatVersion: 1,
      kind: "assistant",
      turnId: 1,
      message: { text: "The test failed on line 61." },
    });

    const { search_transcript } = createSearchTranscriptTool({ eventLog: log });

    // Search finds the needle inside the canonical tool_result even if prompt assembly later stubs res-stubbed-1
    const searchRes = await search_transcript.execute({
      query: "foo/bar.ts:144",
    });
    expect(searchRes.ok).toBe(true);
    if (!searchRes.ok || !("matches" in searchRes)) throw new Error("Expected matches");
    expect(searchRes.matches[0]?.id).toBe("res-stubbed-1");
    expect(searchRes.matches[0]?.snippet).toContain("STUBBED_FINDING_NEEDLE_XYZ");
    expect(searchRes.matches[0]?.snippet.length).toBeLessThanOrEqual(360);
    expect(searchRes.matches[0]?.truncated).toBe(true);
    expect(searchRes.matches[0]?.artifactId).toBe("art_deadbeef1234");

    // Fetch full content by ID with surrounding context messages
    const fetched = await search_transcript.execute({
      id: "res-stubbed-1",
      context_messages: 1,
      offset: 59,
      max_chars: 500,
    });
    expect(fetched.ok).toBe(true);
    if (!fetched.ok || !("message" in fetched)) throw new Error("Expected fetched message");
    expect(fetched.message.id).toBe("res-stubbed-1");
    expect(fetched.message.artifactId).toBe("art_deadbeef1234");
    expect(fetched.message.content).toContain("line-61: STUBBED_FINDING_NEEDLE_XYZ");
    expect(fetched.message.before?.map((m: { id: string }) => m.id)).toEqual(["a-1"]);
    expect(fetched.message.after?.map((m: { id: string }) => m.id)).toEqual(["a-2"]);
  });

  test("describes canonical transcript scope and reset defaults in both prompts and tool descriptions", () => {
    const { log } = openLog();
    const description = searchTranscriptModule.createSearchTranscriptTool({ eventLog: log }).search_transcript.description;
    const texts = [
      buildClassicSystemFrame("/project", "session", []),
      buildSystemFrame("/project", "session", [], undefined, null, true),
      ...[true, false].map((classicMode) => describeTools({ classicMode, contextEngineEnabled: !classicMode })
        .find((line) => line.startsWith("search_transcript("))!),
      `search_transcript: ${description}`,
    ];
    for (const text of texts) {
      expect(text).toContain("search_transcript");
      expect(text).toMatch(/canonical.*records/i);
      expect(text).toMatch(/compact(?:ed|ion).*stub/i);
      expect(text).toContain("current reset epoch");
      expect(text).toContain("by default");
      expect(text).toContain("include_previous_resets");
    }
  });

  test("documents transcript recovery beyond the prompt window and the default reset scope", () => {
    for (const path of ["docs/ARCHITECTURE.md", "docs/concepts.md"]) {
      const text = readFileSync(join(import.meta.dir, "..", path), "utf8");
      const toolLine = text.split("\n").find((line) => line.includes("search_transcript") && /canonical/i.test(line));
      expect(toolLine).toMatch(/compact(?:ed|ion).*stub/i);
      expect(toolLine).toContain("current reset epoch");
      expect(toolLine).toContain("by default");
      expect(toolLine).toContain("include_previous_resets");
      expect(text).not.toContain("information only survives if the checkpoint captured it");
    }
  });

  test("registers search_transcript in createAllTools, describeTools, loop-gate READ_TOOLS, tool-summary, and tool-icons", async () => {
    const { log } = openLog();
    const stateGraph = new StateGraph();

    for (const classicMode of [true, false]) {
      const tools = createAllTools({
        eventLog: log,
        stateGraph,
        memoryStore: null,
        memoryEnabled: false,
        incognito: false,
        contextEngine: null,
        cwd: process.cwd(),
        skills: [],
        skillRuntime: null,
        classicMode,
      });
      expect("search_transcript" in tools).toBe(true);
      expect("search_turn_events" in tools).toBe(false); // contextEngine is null here; search_transcript still works!

      const descriptions = describeTools({ contextEngineEnabled: !classicMode, classicMode });
      expect(descriptions.some((d) => d.startsWith("search_transcript("))).toBe(true);
    }

    expect(isLoopExempt("search_transcript", { query: "test" })).toBe(true);
    expect(summarizeArgs("search_transcript", { query: "needle" })).toBe("needle");
    expect(summarizeArgs("search_transcript", { id: "msg-r1" })).toBe("msg-r1");
    expect(toolIcon("search_transcript", true)).toBe("⌂");
    expect(toolIcon("search_transcript", false)).toBe("st");
  });
});
