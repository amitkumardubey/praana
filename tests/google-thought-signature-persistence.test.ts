import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanonicalTranscriptError, CanonicalWriter, emitCanonicalTranscript, readCanonicalRecords, type CanonicalRecord } from "../src/canonical-transcript.js";
import { buildTurns, materializeHistory } from "../src/compaction.js";
import { buildSameModelSummaryRequest, buildSummaryRepairRequest } from "../src/compaction-requests.js";
import { loadConfig } from "../src/config.js";
import { EventLog } from "../src/event-log.js";
import { buildCommitEvent, minimumValidSummary, restoreFrozenStateFromLog, SESSION_START_EPOCH } from "../src/frozen-summary.js";
import type { AssistantMessage, ConversationMessage } from "../src/llm/types.js";
import { redactSecrets } from "../src/redact/secrets.js";
import { Session } from "../src/session.js";
import { runLlmStream } from "../src/turn.js";
import { googleSse, SKIP_THOUGHT_SIGNATURE, THOUGHT_SIGNATURE } from "./helpers/google-thought-signature.js";

const roots: string[] = [];
const logs: EventLog[] = [];
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
  for (const log of logs.splice(0)) log.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(join(tmpdir(), "google-signature-"));
  roots.push(path);
  return path;
}
function openLog() {
  const log = new EventLog("s", root());
  logs.push(log);
  return log;
}
function writer(log: EventLog) {
  return new CanonicalWriter(log, error => { throw error; });
}
function assistant(signed = true): AssistantMessage {
  return { role: "assistant", content: "reading", toolCalls: [
    { id: "a", name: "read_file", args: { path: "a.txt" }, ...(signed ? { thoughtSignature: THOUGHT_SIGNATURE } : {}) },
    { id: "b", name: "read_file", args: { path: "b.txt" } },
  ] };
}
async function recordBatch(log: EventLog, signed = true) {
  const w = writer(log);
  const turnId = await w.startTurn("read files");
  await w.assistant(turnId, assistant(signed));
  await w.result(turnId, "a", "read_file", "A", false);
  await w.result(turnId, "b", "read_file", "B", false);
}
async function replay(history: ConversationMessage[]) {
  let body: any;
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return googleSse([{ text: "done" }]);
  }) as typeof fetch;
  const result = await runLlmStream({
    model: { __piOptions: { apiKey: "fake-key" } }, modelName: "gemini-test", providerName: "google",
    compiledPrompt: "test", history, piTools: [],
  });
  expect(result.finalReason).toBe("stop");
  expect(result.fullResponse).toBe("done");
  return body;
}
function modelParts(body: any) {
  return body.contents.find((content: any) => content.role === "model").parts;
}

test("canonical writer stores a long base64 thought signature verbatim while redacting only arguments", async () => {
  const log = openLog();
  const w = writer(log);
  const turnId = await w.startTurn("read files");
  const message = assistant();
  message.toolCalls![0].args = { path: "AKIAIOSFODNN7EXAMPLE" };
  message.toolCalls![0].rawArgs = '{"hidden":"AKIAIOSFODNN7EXAMPLE","path":"a.txt"}';
  const before = structuredClone(message);
  expect(THOUGHT_SIGNATURE.length).toBeGreaterThan(300);
  expect(THOUGHT_SIGNATURE).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  expect(redactSecrets(THOUGHT_SIGNATURE)).not.toBe(THOUGHT_SIGNATURE);
  await w.assistant(turnId, message);
  const records = readCanonicalRecords(log);
  const saved = records[1];
  expect(saved).toMatchObject({ formatVersion: 1, kind: "assistant", message: { toolCalls: [
    { id: "a", name: "read_file", args: { path: "[REDACTED:aws-access-key]" }, rawArgs: '{"path":"[REDACTED:aws-access-key]"}', thoughtSignature: THOUGHT_SIGNATURE },
    { id: "b", name: "read_file", args: { path: "b.txt" }, rawArgs: '{"path":"b.txt"}' },
  ] } });
  expect(readFileSync(log.getLogPath(), "utf8")).toContain(THOUGHT_SIGNATURE);
  const emitted = emitCanonicalTranscript(records)[1] as AssistantMessage;
  expect(emitted.toolCalls![0]).toHaveProperty("thoughtSignature", THOUGHT_SIGNATURE);
  expect(emitted.toolCalls![1]).not.toHaveProperty("thoughtSignature");
  emitted.toolCalls![0].args.path = "changed";
  expect(saved.message).toMatchObject({ toolCalls: [{ args: { path: "[REDACTED:aws-access-key]" } }, {}] });
  expect(message).toEqual(before);
});

test("canonical v1 accepts optional nonempty thought signatures and still rejects malformed fields", () => {
  const records: CanonicalRecord[] = [
    { formatVersion: 1, kind: "user_input", turnId: 1, message: { text: "read" } },
    { formatVersion: 1, kind: "assistant", turnId: 1, message: { text: "", toolCalls: assistant().toolCalls } },
  ];
  expect(() => emitCanonicalTranscript(records)).not.toThrow();
  expect(emitCanonicalTranscript(records)[1]).toMatchObject({ toolCalls: [{ thoughtSignature: THOUGHT_SIGNATURE }, {}] });
  for (const invalid of ["", null, 42, {}, undefined]) {
    const malformed = structuredClone(records);
    const call = (malformed[1] as any).message.toolCalls[0];
    call.thoughtSignature = invalid;
    expect(() => emitCanonicalTranscript(malformed)).toThrow(CanonicalTranscriptError);
  }
  const unknownField = structuredClone(records);
  (unknownField[1] as any).message.toolCalls[0].unknown = "not allowed";
  expect(() => emitCanonicalTranscript(unknownField)).toThrow("invalid kind or message payload");
});

test("legacy canonical v1 logs remain readable and replay an unsigned batch with one sentinel", async () => {
  const log = openLog();
  await recordBatch(log, false);
  const records = readCanonicalRecords(log);
  expect(records.every(record => record.formatVersion === 1)).toBe(true);
  const history = emitCanonicalTranscript(records);
  const body = await replay(history);
  expect(modelParts(body).filter((part: any) => part.functionCall)).toEqual([
    { functionCall: { name: "read_file", args: { path: "a.txt" } }, thoughtSignature: SKIP_THOUGHT_SIGNATURE },
    { functionCall: { name: "read_file", args: { path: "b.txt" } } },
  ]);
  expect(JSON.stringify(records)).not.toContain("thoughtSignature");
});

test("Session.resume reopens events.jsonl with the exact signature available for native replay", async () => {
  const cwd = root();
  const config = loadConfig();
  config.session.log_dir = cwd;
  config.memory.enabled = false;
  config.memory.summarizer = "disabled";
  config.context_engine!.enabled = false;
  config.native = { ...config.native!, enabled: false };
  config.skills.enabled = false;
  config.project_detection!.enabled = false;
  const session = Session.createNew("s", cwd, config);
  logs.push(session.eventLog);
  await recordBatch(session.eventLog);
  session.eventLog.close();
  const resumed = await Session.resume("s", cwd, config, { suppressLoggerStderr: true });
  logs.push(resumed.eventLog);
  expect(resumed.eventLog.getLogPath()).toMatch(/events\.jsonl$/);
  const body = await replay(emitCanonicalTranscript(readCanonicalRecords(resumed.eventLog)));
  expect(modelParts(body)[1]).toHaveProperty("thoughtSignature", THOUGHT_SIGNATURE);
  expect(modelParts(body)[2]).not.toHaveProperty("thoughtSignature");
});

test("compaction materialization and same-model summary/repair preserve signed retained calls", async () => {
  const log = openLog();
  const append = (id: string, record: CanonicalRecord) => log.append({ event_id: id, kind: "canonical_message", actor: "kernel", payload: { ...record } });
  append("prefix-input", { formatVersion: 1, kind: "user_input", turnId: 1, message: { text: "old" } });
  append("prefix-end", { formatVersion: 1, kind: "assistant", turnId: 1, message: { text: "old answer" } });
  append("tail-input", { formatVersion: 1, kind: "user_input", turnId: 2, message: { text: "read" } });
  append("tail-calls", { formatVersion: 1, kind: "assistant", turnId: 2, message: { text: "reading", toolCalls: assistant().toolCalls } });
  for (const id of ["a", "b"]) append(`result-${id}`, { formatVersion: 1, kind: "tool_result", turnId: 2, message: { callId: id, toolName: "read_file", text: `original ${id}`, isError: false } });
  log.append(buildCommitEvent({
    formatVersion: 1, resetEpoch: SESSION_START_EPOCH, generation: 1, boundaryEventId: "prefix-end",
    summary: minimumValidSummary(), stubSet: [{ eventId: "result-a", stubText: "stub A" }],
    summaryRequest: { cutDescription: "old turn", capTokens: 1024, instructionSha256: "a".repeat(64), usage: null },
  }));
  const restored = restoreFrozenStateFromLog(log);
  expect(restored.ok).toBe(true);
  if (!restored.ok) throw restored.error;
  const before = JSON.stringify(log.readAll({ includeInternal: true }));
  const materialized = materializeHistory(restored.state, log);
  expect(materialized.ok).toBe(true);
  if (!materialized.ok) throw materialized.error;
  expect(buildTurns(log)[1].messages[1]).toMatchObject({ toolCalls: [{ thoughtSignature: THOUGHT_SIGNATURE }, {}] });
  expect(materialized.messages[3]).toMatchObject({ role: "tool_result", result: "stub A" });
  const summaryRequest = buildSameModelSummaryRequest({ provider: "google", model: "gemini-test", messages: materialized.messages }, "summarize");
  const repair = buildSummaryRepairRequest(summaryRequest, { text: "invalid summary", finishReason: "stop", usage: null, toolCalls: [] }, {
    attempt: 0, capTokens: 1024, contextWindowTokens: 128000, effectiveMaxTokens: 4096,
  });
  expect(repair.status).toBe("repair");
  if (repair.status !== "repair") throw new Error("expected summary repair");
  const body = await replay(repair.request.messages);
  expect(modelParts(body)[1]).toHaveProperty("thoughtSignature", THOUGHT_SIGNATURE);
  expect(modelParts(body)[2]).not.toHaveProperty("thoughtSignature");
  expect(JSON.stringify(log.readAll({ includeInternal: true }))).toBe(before);
});
