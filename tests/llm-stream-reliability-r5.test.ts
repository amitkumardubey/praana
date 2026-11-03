import { afterEach, describe, expect, it } from "bun:test";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jwt = (id = "jwt-account") =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.sig`;

const completed = { type: "response.completed", response: { status: "completed" } };

async function collectResponses(
  provider: string,
  frames: unknown[],
  extra: Partial<StreamRequest> = {},
): Promise<StreamEvent[]> {
  globalThis.fetch = (async () => {
    const sse = frames
      .map((frame) => (typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`))
      .join("");
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const request: StreamRequest = {
    provider,
    model: "gpt-5.4",
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  };
  const auth: ResolvedAuth = provider === "openai-codex" ? { bearerToken: jwt() } : { apiKey: "synthetic-openai-key" };
  const events: StreamEvent[] = [];
  for await (const event of new OpenAIResponsesDriver().stream(request, auth)) events.push(event);
  return events;
}

interface CallSpec {
  index: number;
  id: string;
  callId: string;
  name: string;
  args: string;
  parts: string[];
}

function realisticCallFrames(calls: CallSpec[], withIndex: boolean): unknown[] {
  const frames: unknown[] = [];
  for (const call of calls) {
    frames.push({
      type: "response.output_item.added",
      ...(withIndex ? { output_index: call.index } : {}),
      item: { type: "function_call", id: call.id, call_id: call.callId, name: call.name },
    });
  }
  for (const call of calls) {
    for (const part of call.parts) {
      frames.push({
        type: "response.function_call_arguments.delta",
        ...(withIndex ? { output_index: call.index } : { item_id: call.id }),
        delta: part,
      });
    }
  }
  for (const call of calls) {
    frames.push({
      type: "response.function_call_arguments.done",
      ...(withIndex ? { output_index: call.index } : { item_id: call.id }),
      item: { type: "function_call", id: call.id, call_id: call.callId, name: call.name },
    });
  }
  for (const call of calls) {
    frames.push({
      type: "response.output_item.done",
      ...(withIndex ? { output_index: call.index } : {}),
      item: {
        type: "function_call",
        id: call.id,
        call_id: call.callId,
        name: call.name,
        arguments: call.args,
      },
    });
  }
  frames.push(completed);
  return frames;
}

const oneCall: CallSpec[] = [
  {
    index: 0,
    id: "fc-a",
    callId: "call-a",
    name: "read_file",
    args: '{"path":"a.ts"}',
    parts: ['{"path":', '"a.ts"}'],
  },
];

const twoCalls: CallSpec[] = [
  ...oneCall,
  {
    index: 1,
    id: "fc-b",
    callId: "call-b",
    name: "shell",
    args: '{"cmd":"ls"}',
    parts: ['{"cmd":', '"ls"}'],
  },
];

function expectExactToolArgs(events: StreamEvent[], calls: CallSpec[]): void {
  expect(events.some((event) => event.type === "error")).toBe(false);
  const deltas = events.filter((event) => event.type === "tool_call_delta");
  const fragments = calls.flatMap((call) => call.parts);
  expect(deltas.map((event) => (event.type === "tool_call_delta" ? event.argsDelta : ""))).toEqual(fragments);
  const done = events.at(-1);
  expect(done?.type).toBe("done");
  if (done?.type !== "done") return;
  expect(done.reason).toBe("tool_use");
  expect(done.message.toolCalls?.map((call) => call.rawArgs)).toEqual(calls.map((call) => call.args));
  expect(done.message.toolCalls?.map((call) => call.id)).toEqual(calls.map((call) => call.callId));
}

const lenient = { strictStreamEnd: false as const };

function expectStreamError(events: StreamEvent[], message: string): void {
  expect(events.some((event) => event.type === "done")).toBe(false);
  expect(events.some((event) => event.type === "tool_call_end")).toBe(false);
  const error = events.at(-1);
  expect(error?.type === "error" && error.error.message).toBe(message);
}

describe("Responses failures are errors on the lenient path", () => {
  const finishedTool = [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "function_call", call_id: "call-1", name: "read_file" },
    },
    { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"a.ts"}' },
    { type: "response.function_call_arguments.done", output_index: 0 },
  ];

  it("does not publish a completed tool call when response.failed arrives", async () => {
    const events = await collectResponses("openai", [
      ...finishedTool,
      { type: "response.failed", response: { status: "failed", error: { message: "boom" } } },
    ], lenient);
    expectStreamError(events, "boom");
  });

  it("reports an error frame instead of a normal finish", async () => {
    const events = await collectResponses("openai", [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "error", error: { message: "Backend unavailable" } },
    ], lenient);
    expectStreamError(events, "Backend unavailable");
  });

  it.each(["failed", "cancelled"] as const)("reports response.done status %s instead of stop", async (status) => {
    const events = await collectResponses("openai", [
      ...finishedTool,
      { type: "response.done", response: { status, error: { message: "Backend unavailable" } } },
    ], lenient);
    expectStreamError(events, "Backend unavailable");
  });

  it("still accepts a lenient clean close that never sends a terminal event", async () => {
    const events = await collectResponses("openai", [
      { type: "response.output_text.delta", delta: "partial" },
    ], lenient);
    expect(events.at(-1)).toEqual({
      type: "done",
      reason: "stop",
      message: { role: "assistant", content: "partial" },
    });
  });
});

describe("Responses argument deltas that arrive before the call is announced", () => {
  it("merges delta, delta, added, done into the original JSON", async () => {
    const args = '{"path":"a.ts"}';
    const events = await collectResponses("openai", [
      { type: "response.function_call_arguments.delta", item_id: "fc-1", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", item_id: "fc-1", delta: '"a.ts"}' },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "read_file" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "read_file", arguments: args },
      },
      completed,
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const done = events.at(-1);
    expect(done?.type === "done" && done.message.toolCalls?.[0]?.rawArgs).toBe(args);
    expect(events.filter((event) => event.type === "tool_call_delta")).toHaveLength(1);
  });

  it("still errors when a buffered call never receives added or done", async () => {
    const events = await collectResponses("openai", [
      { type: "response.function_call_arguments.delta", item_id: "fc-kept", delta: '{"path":"a.ts"}' },
      {
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc-opened", call_id: "call-opened", name: "shell", arguments: "{}" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc-orphan", delta: '{"cmd":"ls"}' },
      completed,
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const error = events.at(-1);
    expect(error?.type === "error" && error.error.message).toBe(
      "OpenAI Responses stream received function call arguments without an open call",
    );
  });
});

describe("Responses tool arguments are not repeated", () => {
  it.each([
    ["openai", true, oneCall],
    ["openai", false, oneCall],
    ["openai", true, twoCalls],
    ["openai", false, twoCalls],
    ["openai-codex", true, oneCall],
    ["openai-codex", false, oneCall],
    ["openai-codex", true, twoCalls],
    ["openai-codex", false, twoCalls],
  ] as const)("%s keeps each fragment once (output_index=%s)", async (provider, withIndex, calls) => {
    const events = await collectResponses(provider, realisticCallFrames(calls, withIndex));
    expectExactToolArgs(events, calls);
  });
});
