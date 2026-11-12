import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as nativeLlm from "../src/llm/index.js";
import * as toolRegistry from "../src/tools/index.js";
import * as oauth from "../src/oauth.js";
import * as canonical from "../src/canonical-transcript.js";
import * as loggerModule from "../src/logger.js";
import { Session } from "../src/session.js";
import { loadConfig } from "../src/config.js";
import { runTurn } from "../src/turn.js";
import { TurnAbortedError } from "../src/turn-control.js";
import { EventLog, readSessionMeta } from "../src/event-log.js";
import { OpenTuiSink } from "../src/ui/tui/sink.js";
import { TranscriptProjection } from "../src/ui/tui/transcript/projection.js";
import type { TranscriptMount } from "../src/ui/tui/transcript/mount.js";
import type { ToastApi } from "../src/ui/tui/shell-ui.js";
import type { AssistantMessage, ConversationMessage, StreamRequest, StreamEvent } from "../src/llm/types.js";
import type { Event } from "../src/types.js";

const roots: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  mock.restore();
  for (const log of logs.splice(0)) log.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "canonical-recording-"));
  roots.push(root);
  const config = loadConfig();
  config.session.log_dir = root;
  config.memory.enabled = false;
  config.memory.summarizer = "disabled";
  config.context_engine!.enabled = false;
  config.native = { ...config.native!, enabled: false };
  config.llm = { provider: "openrouter", model: "test/model" };
  const session = Session.createNew("session", root, config);
  session.headless = true;
  logs.push(session.eventLog);
  spyOn(session, "ensureModelContextWindow").mockResolvedValue(128000);
  spyOn(oauth, "resolveOAuthModelAuth").mockResolvedValue(null);
  const events = (): Event[] => readFileSync(session.eventLog.getLogPath(), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const records = () => canonical.readFullSessionCanonicalRecords(events());
  return { session, events, records };
}
function stream(message: AssistantMessage, reason: "stop" | "toolUse" = "stop", extra: StreamEvent[] = []) {
  return (async function* (): AsyncGenerator<StreamEvent> {
    for (const event of extra) yield event;
    for (const call of message.toolCalls ?? []) yield { type: "tool_call_end", toolCall: call };
    if (message.content) yield { type: "text_delta", delta: message.content };
    yield { type: "done", reason: reason === "toolUse" ? "tool_use" : reason, message };
  })();
}
const user = (text: string, turnId = 1): canonical.CanonicalRecord => ({ formatVersion: 1, kind: "user_input", turnId, message: { text } });
const batch: canonical.CanonicalRecord = { formatVersion: 1, kind: "assistant", turnId: 1, message: { text: "", toolCalls: ["a", "b"].map((id) => ({ id, name: "echo", args: {} })) } };
function writer(log: EventLog, errors: unknown[] = []) {
  expect(canonical).toHaveProperty("CanonicalWriter");
  return new canonical.CanonicalWriter(log, (error, context) => { errors.push({ error, context }); });
}

test.each([false, true])("legacy resumed turns never record or repair, partial=%s", async (partial) => {
  const { session, records } = setup();
  if (partial) {
    session.eventLog.append({ kind: "canonical_message", actor: "kernel", payload: user("old") });
    session.eventLog.append({ kind: "canonical_message", actor: "kernel", payload: batch });
  }
  const before = structuredClone(records());
  const meta = readSessionMeta(session.config.session.log_dir, session.id)!;
  delete meta.canonical_transcript;
  writeFileSync(join(session.config.session.log_dir, session.id, "meta.json"), JSON.stringify(meta));
  session.eventLog.close();
  const resumed = await Session.resume(session.id, session.cwd, session.config, { suppressLoggerStderr: true });
  logs.push(resumed.eventLog);
  spyOn(resumed, "ensureModelContextWindow").mockResolvedValue(128000);
  const requests: ConversationMessage[][] = [];
  spyOn(nativeLlm, "streamLlmResponse").mockImplementation((request) => {
    requests.push(structuredClone(request.messages));
    return stream({ role: "assistant", content: "done" });
  });
  await runTurn(resumed, "hello", undefined, { sink: {} });
  expect(canonical.readFullSessionCanonicalRecords(resumed.eventLog.readAll({ includeCanonical: true }))).toEqual(before);
  expect(requests[0].at(-1)).toEqual({ role: "user", content: "hello" });
  expect(resumed.eventLog.readAll().some((e) => e.kind === "user_message")).toBe(true);
});

test("resumed canonical turns continue the session sequence", async () => {
  const { session } = setup();
  await writer(session.eventLog).startTurn("first");
  session.eventLog.close();
  const resumed = await Session.resume(session.id, session.cwd, session.config, { suppressLoggerStderr: true });
  logs.push(resumed.eventLog);
  spyOn(resumed, "ensureModelContextWindow").mockResolvedValue(128000);
  spyOn(nativeLlm, "streamLlmResponse").mockImplementation(() => stream({ role: "assistant", content: "done" }));
  await runTurn(resumed, "second", undefined, { sink: {} });
  expect(canonical.readFullSessionCanonicalRecords(resumed.eventLog.readAll({ includeCanonical: true })).map((record) => record.turnId)).toEqual([1, 2, 2]);
});

test("canonical write failure warns once without a UI error", async () => {
  const { session } = setup();
  const lines: string[] = [];
  const logger = loggerModule.createTestLogger((line) => lines.push(line));
  spyOn(loggerModule, "createSessionLogger").mockResolvedValue(logger);
  const append = session.eventLog.append.bind(session.eventLog);
  spyOn(session.eventLog, "append").mockImplementation((event) => {
    if (event.kind === "canonical_message") throw new Error("canonical disk failure");
    return append(event);
  });
  spyOn(nativeLlm, "streamLlmResponse").mockImplementation(() => stream({ role: "assistant", content: "done" }));
  const onError = mock(() => {});
  await runTurn(session, "hello", undefined, { sink: { onError } });
  expect(onError).not.toHaveBeenCalled();
  const failures = lines.map((line) => JSON.parse(line)).filter((entry) => entry.msg?.includes("Canonical transcript recording stopped"));
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ level: 40, details: { sessionId: session.id, kind: "user_input", turnId: 1 } });
  expect(JSON.stringify(failures[0])).toContain("canonical disk failure");
});

test.each([false, true])("writer repairs crashed batches before a new input, partial=%s", async (partial) => {
  const { session, records } = setup();
  session.eventLog.append({ kind: "canonical_message", actor: "kernel", payload: user("old") });
  session.eventLog.append({ kind: "canonical_message", actor: "kernel", payload: batch });
  if (partial) session.eventLog.append({ kind: "canonical_message", actor: "kernel", payload: { formatVersion: 1, kind: "tool_result", turnId: 1, message: { callId: "a", toolName: "echo", ...canonical.INTERRUPTED_TOOL_RESULT } } });
  expect(await writer(session.eventLog).startTurn("new")).toBe(2);
  expect(records().map((r) => r.kind)).toEqual(["user_input", "assistant", "tool_result", "tool_result", "user_input"]);
  expect(records().filter((r) => r.kind === "tool_result").map((r) => r.message)).toEqual(["a", "b"].map((callId) => ({ callId, toolName: "echo", text: "Tool execution was interrupted before a result was recorded.", isError: true })));
  expect(canonical.emitCanonicalTranscript(records())).toHaveLength(5);
});

test.each([false, true])("writer surfaces append failure and stops writing until reopened, persisted=%s", async (persisted) => {
  const { session, records } = setup();
  const errors: unknown[] = [];
  const w = writer(session.eventLog, errors);
  const append = session.eventLog.append.bind(session.eventLog);
  const fail = spyOn(session.eventLog, "append").mockImplementation((event) => {
    if (persisted) append(event);
    throw new Error("disk unavailable");
  });
  expect(await w.startTurn("first")).toBeNull();
  expect(await w.startTurn("not written")).toBeNull();
  expect(fail).toHaveBeenCalledTimes(1);
  expect(errors).toHaveLength(1);
  fail.mockRestore();
  expect(await writer(session.eventLog).startTurn("retry")).toBe(persisted ? 2 : 1);
  expect(records().at(-1)).toEqual(user("retry", persisted ? 2 : 1));
});

test.each(["headless", "tui"])("persists sanitized multi-step history before use; existing result copies unchanged (%s)", async (mode) => {
  const { session, events, records } = setup();
  const received: unknown[] = [];
  const result = { ok: false, content: "  AKIAIOSFODNN7EXAMPLE\n\u0000\r\n" };
  spyOn(toolRegistry, "createAllTools").mockReturnValue({ echo: { description: "echo", parameters: {}, execute: async (args: unknown) => {
    expect(records().map((r) => r.kind)).toEqual(["user_input", "assistant"]);
    received.push(args);
    return result;
  } } } as any);
  const first: AssistantMessage = { role: "assistant", content: "checking", thinking: "onetwo", thinkingSignature: "s1s2", blocks: [
    { type: "thinking", thinking: "one", signature: "s1" }, { type: "redacted_thinking", data: "opaque==" },
    { type: "thinking", thinking: "two", signature: "s2" }, { type: "text", text: "checking" }, { type: "tool_use", id: "a" },
  ], toolCalls: [{ id: "a", name: "echo", args: { visible: "AKIAIOSFODNN7EXAMPLE", hidden: "safe" }, rawArgs: '{"visible":"AKIAIOSFODNN7EXAMPLE","hidden":"AKIAABCDEFGHIJKLMNOP","hidden":"safe"}' }] };
  const requests: ConversationMessage[][] = [];
  spyOn(nativeLlm, "streamLlmResponse").mockImplementation((request: StreamRequest) => {
    requests.push(structuredClone(request.messages));
    if (requests.length === 1) expect(records()).toEqual([user("inspect")]);
    else expect(records().map((r) => r.kind)).toEqual(["user_input", "assistant", "tool_result"]);
    return stream(requests.length === 1 ? first : { role: "assistant", content: "done" }, requests.length === 1 ? "toolUse" : "stop");
  });
  const projection = new TranscriptProjection({ useUnicode: true });
  const sink = mode === "headless" ? {} : new OpenTuiSink({ renderEntries() {}, appendEntry() {}, appendAssistantDelta: () => true, appendThinkingDelta: () => true, patchToolResult: () => true } as unknown as TranscriptMount, { show() {}, clearErrors() {} } as unknown as ToastApi, {
    ambient: "quiet", showThinking: () => true, onSpinnerMessage() {}, ctxWindowTokens: 128000, engineMode: false, projection,
    persistEntry: (entry) => session.eventLog.append({ kind: "ui_transcript", actor: "kernel", payload: { type: "entry", entry } }),
  });
  await runTurn(session, "inspect", undefined, { sink });
  expect(received).toEqual([{ visible: "AKIAIOSFODNN7EXAMPLE", hidden: "safe" }]);
  expect(requests[1][1]).toEqual(first);
  expect(requests[1][2]).toEqual({ role: "tool_result", toolCallId: "a", toolName: "echo", result: '{"ok":false,"content":"  [REDACTED:aws-access-key]\\n\\u0000\\r\\n"}', isError: false });
  const replay = canonical.emitCanonicalTranscript(records());
  const expected = structuredClone([...requests[1], { role: "assistant", content: "done" }]);
  expected[1] = { ...first, toolCalls: [{ id: "a", name: "echo", args: { visible: "[REDACTED:aws-access-key]", hidden: "safe" }, rawArgs: '{"visible":"[REDACTED:aws-access-key]","hidden":"safe"}' }] };
  expected[2] = { role: "tool_result", toolCallId: "a", toolName: "echo", result: '{"ok":false,"content":"  [REDACTED:aws-access-key]\\n\\u0000\\r\\n"}', isError: false };
  expect(replay).toEqual(expected);
  const stored = records().filter((r) => r.kind === "tool_result");
  expect(stored).toHaveLength(1);
  expect(stored[0].message.text.length).toBe('{"ok":false,"content":"  [REDACTED:aws-access-key]\\n\\u0000\\r\\n"}'.length);
  expect(JSON.stringify(records())).not.toContain("AKIA");
  expect(events().filter((e) => e.kind === "tool_result").map((e) => e.payload)).toEqual([{ toolCallId: "a", tool: "echo", result: { ok: false, content: "  [REDACTED:aws-access-key]\n\u0000\r\n" } }]);
  const uiTools = events().filter((e) => e.kind === "ui_transcript").map((e) => e.payload.entry as any).filter((e) => e.role === "tool");
  if (mode === "tui") {
    expect(uiTools).toHaveLength(2); // Pending entry, then completed entry, as before.
    const baselineEntries: unknown[] = [];
    const baseline = new OpenTuiSink({ renderEntries() {}, appendEntry() {}, patchToolResult: () => true } as unknown as TranscriptMount, { show() {} } as unknown as ToastApi, {
      ambient: "quiet", showThinking: () => true, onSpinnerMessage() {}, ctxWindowTokens: 128000, engineMode: false,
      projection: new TranscriptProjection({ useUnicode: true }), persistEntry: (entry) => baselineEntries.push(entry),
    });
    baseline.onToolCall("baseline-id", "echo", { visible: "[REDACTED:aws-access-key]", hidden: "safe" });
    baseline.onToolResult("baseline-id", "echo", '{"ok":false,"content":"  [REDACTED:aws-access-key]\\n\\u0000\\r\\n"}', false);
    const contentOnly = (entries: any[]) => entries.map(({ id: _id, timestamp: _timestamp, ...content }) => content);
    expect(contentOnly(uiTools)).toEqual(contentOnly(baselineEntries));
  } else expect(uiTools).toHaveLength(0);
});

test("synthetic not-executed results precede logical wrap-up and text-only reply", async () => {
  const { session, records } = setup();
  session.headless = false;
  session.config.turn = { max_steps: 2, pause_after_steps: 1, hard_max_steps: 3 };
  const execute = mock(async () => ({}));
  spyOn(toolRegistry, "createAllTools").mockReturnValue({ echo: { execute } } as any);
  let requests = 0;
  spyOn(nativeLlm, "streamLlmResponse").mockImplementation((req) => {
    if (++requests === 1) return stream({ role: "assistant", content: "", toolCalls: [{ id: "a", name: "echo", args: {} }] }, "toolUse");
    expect(records().map((r) => r.kind)).toEqual(["user_input", "assistant", "tool_result", "wrap_up"]);
    expect(req.tools).toHaveLength(0);
    expect(req.messages.some((m) => m.role === "tool_result")).toBe(false);
    return stream({ role: "assistant", content: "summary", thinking: "discard", toolCalls: [{ id: "ignored", name: "echo", args: {} }] }, "toolUse");
  });
  await runTurn(session, "inspect", undefined, { sink: { onStepPause: async () => false } });
  expect(execute).not.toHaveBeenCalled();
  expect(records()[2]).toMatchObject({ message: { text: "Not executed: the step budget was reached and the turn was stopped.", isError: true } });
  expect(records().at(-1)).toEqual({ formatVersion: 1, kind: "assistant", turnId: 1, message: { text: "summary" } });
  expect(canonical.nextCanonicalTurnId(records())).toBe(2);
});

test("accepted timeout text and final no-tool steps are recorded", async () => {
  const { session, records } = setup();
  spyOn(nativeLlm, "streamLlmResponse").mockImplementation(() => (async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", delta: "partial" };
    yield { type: "done", reason: "timeout", message: { role: "assistant", content: "partial", toolCalls: [{ id: "discarded", name: "echo", args: {} }] } };
  })());
  await runTurn(session, "inspect", undefined, { sink: {} });
  expect(records()).toEqual([user("inspect"), { formatVersion: 1, kind: "assistant", turnId: 1, message: { text: "partial" } }]);
});

test("credential failure before dispatch consumes no canonical turn", async () => {
  const { session, records } = setup();
  spyOn(oauth, "resolveOAuthModelAuth").mockRejectedValue(new oauth.OAuthRefreshError("openrouter", "OpenRouter", "sign in"));
  const request = spyOn(nativeLlm, "streamLlmResponse");
  await runTurn(session, "never sent", undefined, { sink: {} });
  expect(request).not.toHaveBeenCalled();
  expect(records()).toEqual([]);
  spyOn(oauth, "resolveOAuthModelAuth").mockResolvedValue(null);
  request.mockImplementation(() => stream({ role: "assistant", content: "ok" }));
  await runTurn(session, "sent", undefined, { sink: {} });
  expect(records()[0]).toEqual(user("sent"));
});

test("cooperative abort records Interrupted results in batch order", async () => {
  const { session, records } = setup();
  const abort = new AbortController();
  spyOn(toolRegistry, "createAllTools").mockReturnValue({ echo: { execute: async () => ({ ok: true }) } } as any);
  spyOn(session.hooks, "runPreToolCall").mockImplementation((input) => {
    abort.abort();
    return Promise.resolve({ action: "continue", args: input.args });
  });
  spyOn(nativeLlm, "streamLlmResponse").mockImplementation(() => stream({ role: "assistant", content: "", toolCalls: ["a", "b"].map((id) => ({ id, name: "echo", args: {} })) }, "toolUse"));
  await expect(runTurn(session, "inspect", undefined, { signal: abort.signal, sink: {} })).rejects.toBeInstanceOf(TurnAbortedError);
  expect(records().map((r) => r.kind)).toEqual(["user_input", "assistant", "tool_result", "tool_result"]);
  expect(records()[3]).toMatchObject({ kind: "tool_result", message: { callId: "b", text: '{"ok":false,"error":"Interrupted"}', isError: true } });
  expect(canonical.emitCanonicalTranscript(records())).toHaveLength(4);
});

test("pre-block errors are sanitized only in the canonical result and preserve the history error flag", async () => {
  const { session, records } = setup();
  spyOn(toolRegistry, "createAllTools").mockReturnValue({ echo: { execute: mock() } } as any);
  spyOn(session.hooks, "runPreToolCall").mockResolvedValue({ action: "block", isError: true, error: "AKIAIOSFODNN7EXAMPLE" });
  let count = 0;
  spyOn(nativeLlm, "streamLlmResponse").mockImplementation((req) => {
    if (++count === 1) return stream({ role: "assistant", content: "", toolCalls: [{ id: "a", name: "echo", args: {} }] }, "toolUse");
    expect(req.messages.at(-1)).toMatchObject({ role: "tool_result", isError: true, result: '{"ok":false,"error":"AKIAIOSFODNN7EXAMPLE"}' });
    return stream({ role: "assistant", content: "done" });
  });
  await runTurn(session, "inspect", undefined, { sink: {} });
  expect(records()[2]).toMatchObject({ kind: "tool_result", message: { isError: true, text: '{"ok":false,"error":"[REDACTED:aws-access-key]"}' } });
});
