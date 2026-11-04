import { afterEach, describe, expect, it } from "bun:test";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import { parseSseStream } from "../src/llm/sse.js";
import { isDefaultHostedEndpoint, resolveStreamEndMode } from "../src/llm/stream-end.js";
import { ToolCallAccumulator } from "../src/llm/tool-accumulator.js";
import { resolveLlmStreamTimeouts } from "../src/llm/stream-guard.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";

/**
 * Lenient streams may keep text and may run a tool whose arguments parsed as
 * sent. They must not run a call that was still open or whose JSON had to be
 * repaired. Removing that guard in a driver makes the invariants table fail.
 * An unterminated stream also drops a call whose argument text is empty or
 * does not start with `{`. Removing that rule makes the F2 rows publish the
 * call. Applying it to a terminated stream makes the terminated-empty rows fail.
 *
 * The table cannot catch:
 * - a Google functionCall whose args are a syntactically valid object that is
 *   only semantically truncated (the SSE frame parsed; there is no string to repair)
 * - an SSE frame cut mid-line, which the parser drops before a driver sees it
 */

const CUTOFF = "The response was cut off while the model was calling a tool";
const originalFetch = globalThis.fetch;
const originalRandom = Math.random;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

function sse(frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

async function collect(
  iterable: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function withFetch(body: BodyInit): void {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
}

const auth: ResolvedAuth = { apiKey: "test-key" };

function req(provider: string, strictStreamEnd: boolean): StreamRequest {
  return {
    model: "m",
    provider,
    messages: [{ role: "user", content: "hi" }],
    strictStreamEnd,
  };
}

function textOf(events: StreamEvent[]): string {
  return events
    .filter((event): event is Extract<StreamEvent, { type: "text_delta" }> => event.type === "text_delta")
    .map((event) => event.delta)
    .join("");
}

function published(events: StreamEvent[]): boolean {
  return events.some((event) => event.type === "tool_call_end");
}

function cutoff(events: StreamEvent[]): Extract<StreamEvent, { type: "error" }> | undefined {
  return events.find(
    (event): event is Extract<StreamEvent, { type: "error" }> =>
      event.type === "error" && event.error.message === CUTOFF,
  );
}

const openaiTruncated = sse([
  { choices: [{ delta: { content: "Looking" } }] },
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_1",
          function: { name: "read_file", arguments: '{"path":"/etc/pas' },
        }],
      },
    }],
  },
]);

const openaiComplete = sse([
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_1",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        }],
      },
    }],
  },
]);

const openaiTerminal = sse([
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_1",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        }],
      },
    }],
  },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
]) + "data: [DONE]\n\n";

const anthropicTruncated = sse([
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking" } },
  { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
  { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"/etc/pas' } },
]);

const anthropicComplete = sse([
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
]);

const anthropicTerminal = sse([
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
  { type: "message_stop" },
]);

const responsesTruncated = [
  { type: "response.output_text.delta", delta: "Looking" },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"path":"/etc/pas' },
];

const responsesComplete = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
  },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"path":"a.ts"}' },
];

const responsesTerminal = [
  ...responsesComplete,
  { type: "response.completed", response: { status: "completed" } },
];

const openaiEmpty = sse([
  {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file" } }],
      },
    }],
  },
]);

const openaiScalar = sse([
  {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_1",
          function: { name: "read_file", arguments: "12" },
        }],
      },
    }],
  },
]);

const openaiTerminatedEmpty = sse([
  {
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file" } }],
      },
      finish_reason: "tool_calls",
    }],
  },
]) + "data: [DONE]\n\n";

const anthropicEmpty = sse([
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
]);

const anthropicScalar = sse([
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "true" } },
]);

const anthropicTerminatedEmpty = sse([
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]);

const responsesEmpty = [
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
  },
];

const responsesScalar = [
  ...responsesEmpty,
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "12" },
];

const responsesTerminatedEmpty = [
  ...responsesEmpty,
  { type: "response.completed", response: { status: "completed" } },
];

function googleTerminatedEmpty(): string {
  return sse([{
    candidates: [{
      content: { parts: [{ functionCall: { name: "read_file", args: "" } }] },
      finishReason: "STOP",
    }],
  }]);
}

function googleBody(args: unknown, text = false): string {
  const parts: unknown[] = [];
  if (text) parts.push({ text: "Looking" });
  parts.push({ functionCall: { name: "read_file", args } });
  return sse([{ candidates: [{ content: { parts } }] }]);
}

const googleTerminal = sse([{
  candidates: [{
    content: { parts: [{ functionCall: { name: "read_file", args: { path: "a.ts" } } }] },
    finishReason: "STOP",
  }],
}]);

describe("lenient tool cutoff", () => {
  it("openai: truncated args, no terminal, do not publish", async () => {
    withFetch(openaiTruncated);
    const events = await collect(new OpenAICompatibleDriver().stream(req("openai", false), auth));
    expect(textOf(events)).toBe("Looking");
    expect(published(events)).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const error = cutoff(events);
    expect(error?.retryable).toBe(false);
  });

  it("openai: complete args, no terminal, still publish", async () => {
    withFetch(openaiComplete);
    const events = await collect(new OpenAICompatibleDriver().stream(req("openai", false), auth));
    expect(published(events)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "tool_use",
      message: { toolCalls: [{ id: "call_1", name: "read_file", args: { path: "a.ts" } }] },
    });
  });

  it("openai: strict close is still premature_end", async () => {
    withFetch(openaiTruncated);
    const events = await collect(new OpenAICompatibleDriver().stream(req("openai", true), auth));
    expect(published(events)).toBe(false);
    const error = events.at(-1);
    expect(error?.type === "error" && error.kind).toBe("premature_end");
  });

  it("openai: a normal tool_calls terminal is unchanged", async () => {
    withFetch(openaiTerminal);
    const events = await collect(new OpenAICompatibleDriver().stream(req("openai", true), auth));
    expect(published(events)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
    expect(cutoff(events)).toBeUndefined();
  });

  it("anthropic: truncated args, no terminal, do not publish", async () => {
    withFetch(anthropicTruncated);
    const events = await collect(new AnthropicDriver().stream(req("anthropic", false), auth));
    expect(textOf(events)).toBe("Looking");
    expect(published(events)).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(cutoff(events)?.retryable).toBe(false);
  });

  it("anthropic: complete args, no terminal, still publish", async () => {
    withFetch(anthropicComplete);
    const events = await collect(new AnthropicDriver().stream(req("anthropic", false), auth));
    expect(published(events)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "tool_use",
      message: { toolCalls: [{ id: "toolu_1", args: { path: "a.ts" } }] },
    });
  });

  it("anthropic: strict close is still premature_end", async () => {
    withFetch(anthropicTruncated);
    const events = await collect(new AnthropicDriver().stream(req("anthropic", true), auth));
    expect(published(events)).toBe(false);
    expect(events.at(-1)?.type === "error" && events.at(-1)).toMatchObject({ kind: "premature_end" });
  });

  it("anthropic: a normal tool_use terminal is unchanged", async () => {
    withFetch(anthropicTerminal);
    const events = await collect(new AnthropicDriver().stream(req("anthropic", true), auth));
    expect(published(events)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
  });

  async function responses(frames: unknown[], strict: boolean): Promise<StreamEvent[]> {
    withFetch(sse(frames));
    return collect(new OpenAIResponsesDriver().stream(req("openai", strict), auth));
  }

  it("responses: truncated args, no terminal, do not publish", async () => {
    const events = await responses(responsesTruncated, false);
    expect(textOf(events)).toBe("Looking");
    expect(published(events)).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(cutoff(events)?.retryable).toBe(false);
  });

  it("responses: complete args, no terminal, still publish", async () => {
    const events = await responses(responsesComplete, false);
    expect(published(events)).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "tool_use",
      message: { toolCalls: [{ name: "read_file", args: { path: "a.ts" } }] },
    });
  });

  it("responses: strict close is still premature_end", async () => {
    const events = await responses(responsesTruncated, true);
    expect(published(events)).toBe(false);
    expect(events.at(-1)?.type === "error" && events.at(-1)).toMatchObject({ kind: "premature_end" });
  });

  it("responses: a completed terminal is unchanged", async () => {
    const events = await responses(responsesTerminal, false);
    expect(published(events)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
    expect(cutoff(events)).toBeUndefined();
  });

  it("google: args cut mid-string, no terminal, do not publish", async () => {
    withFetch(googleBody('{"path":"/etc/pas', true));
    const events = await collect(new GoogleDriver().stream(req("google", false), auth));
    expect(textOf(events)).toBe("Looking");
    expect(published(events)).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect(cutoff(events)?.retryable).toBe(false);
  });

  it("google: complete object args, no terminal, still publish", async () => {
    Math.random = () => 0.123456789;
    withFetch(googleBody({ path: "a.ts" }));
    const events = await collect(new GoogleDriver().stream(req("google", false), auth));
    expect(published(events)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
  });

  it("google: strict close is still premature_end", async () => {
    withFetch(googleBody('{"path":"/etc/pas', true));
    const events = await collect(new GoogleDriver().stream(req("google", true), auth));
    expect(published(events)).toBe(false);
    expect(events.at(-1)?.type === "error" && events.at(-1)).toMatchObject({ kind: "premature_end" });
  });

  it("google: a STOP terminal is unchanged", async () => {
    Math.random = () => 0.123456789;
    withFetch(googleTerminal);
    const events = await collect(new GoogleDriver().stream(req("google", true), auth));
    expect(published(events)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
  });
});

describe("invariants across drivers", () => {
  const rows: Array<{
    driver: string;
    truncated: () => Promise<StreamEvent[]>;
    complete: () => Promise<StreamEvent[]>;
    strict: () => Promise<StreamEvent[]>;
    terminal: () => Promise<StreamEvent[]>;
    empty: () => Promise<StreamEvent[]>;
    scalar: () => Promise<StreamEvent[]>;
    terminatedEmpty: () => Promise<StreamEvent[]>;
  }> = [
    {
      driver: "openai",
      truncated: async () => {
        withFetch(openaiTruncated);
        return collect(new OpenAICompatibleDriver().stream(req("openai", false), auth));
      },
      complete: async () => {
        withFetch(openaiComplete);
        return collect(new OpenAICompatibleDriver().stream(req("openai", false), auth));
      },
      strict: async () => {
        withFetch(openaiTruncated);
        return collect(new OpenAICompatibleDriver().stream(req("openai", true), auth));
      },
      terminal: async () => {
        withFetch(openaiTerminal);
        return collect(new OpenAICompatibleDriver().stream(req("openai", true), auth));
      },
      empty: async () => {
        withFetch(openaiEmpty);
        return collect(new OpenAICompatibleDriver().stream(req("openai", false), auth));
      },
      scalar: async () => {
        withFetch(openaiScalar);
        return collect(new OpenAICompatibleDriver().stream(req("openai", false), auth));
      },
      terminatedEmpty: async () => {
        withFetch(openaiTerminatedEmpty);
        return collect(new OpenAICompatibleDriver().stream(req("openai", true), auth));
      },
    },
    {
      driver: "anthropic",
      truncated: async () => {
        withFetch(anthropicTruncated);
        return collect(new AnthropicDriver().stream(req("anthropic", false), auth));
      },
      complete: async () => {
        withFetch(anthropicComplete);
        return collect(new AnthropicDriver().stream(req("anthropic", false), auth));
      },
      strict: async () => {
        withFetch(anthropicTruncated);
        return collect(new AnthropicDriver().stream(req("anthropic", true), auth));
      },
      terminal: async () => {
        withFetch(anthropicTerminal);
        return collect(new AnthropicDriver().stream(req("anthropic", true), auth));
      },
      empty: async () => {
        withFetch(anthropicEmpty);
        return collect(new AnthropicDriver().stream(req("anthropic", false), auth));
      },
      scalar: async () => {
        withFetch(anthropicScalar);
        return collect(new AnthropicDriver().stream(req("anthropic", false), auth));
      },
      terminatedEmpty: async () => {
        withFetch(anthropicTerminatedEmpty);
        return collect(new AnthropicDriver().stream(req("anthropic", true), auth));
      },
    },
    {
      driver: "responses",
      truncated: async () => {
        withFetch(sse(responsesTruncated));
        return collect(new OpenAIResponsesDriver().stream(req("openai", false), auth));
      },
      complete: async () => {
        withFetch(sse(responsesComplete));
        return collect(new OpenAIResponsesDriver().stream(req("openai", false), auth));
      },
      strict: async () => {
        withFetch(sse(responsesTruncated));
        return collect(new OpenAIResponsesDriver().stream(req("openai", true), auth));
      },
      terminal: async () => {
        withFetch(sse(responsesTerminal));
        return collect(new OpenAIResponsesDriver().stream(req("openai", false), auth));
      },
      empty: async () => {
        withFetch(sse(responsesEmpty));
        return collect(new OpenAIResponsesDriver().stream(req("openai", false), auth));
      },
      scalar: async () => {
        withFetch(sse(responsesScalar));
        return collect(new OpenAIResponsesDriver().stream(req("openai", false), auth));
      },
      terminatedEmpty: async () => {
        withFetch(sse(responsesTerminatedEmpty));
        return collect(new OpenAIResponsesDriver().stream(req("openai", false), auth));
      },
    },
    {
      driver: "google",
      truncated: async () => {
        withFetch(googleBody('{"path":"/etc/pas', true));
        return collect(new GoogleDriver().stream(req("google", false), auth));
      },
      complete: async () => {
        withFetch(googleBody({ path: "a.ts" }));
        return collect(new GoogleDriver().stream(req("google", false), auth));
      },
      strict: async () => {
        withFetch(googleBody('{"path":"/etc/pas', true));
        return collect(new GoogleDriver().stream(req("google", true), auth));
      },
      terminal: async () => {
        withFetch(googleTerminal);
        return collect(new GoogleDriver().stream(req("google", true), auth));
      },
      empty: async () => {
        withFetch(googleBody(""));
        return collect(new GoogleDriver().stream(req("google", false), auth));
      },
      scalar: async () => {
        withFetch(googleBody("12"));
        return collect(new GoogleDriver().stream(req("google", false), auth));
      },
      terminatedEmpty: async () => {
        withFetch(googleTerminatedEmpty());
        return collect(new GoogleDriver().stream(req("google", true), auth));
      },
    },
  ];

  for (const row of rows) {
    it(`${row.driver}: I1 no repaired tool, I2 text kept, I4 cutoff reported`, async () => {
      const events = await row.truncated();
      expect(published(events), row.driver).toBe(false);
      expect(textOf(events), row.driver).toBe("Looking");
      expect(cutoff(events)?.retryable, row.driver).toBe(false);
    });

    it(`${row.driver}: I1 clean JSON may run without a terminal`, async () => {
      const events = await row.complete();
      expect(published(events), row.driver).toBe(true);
      expect(events.at(-1), row.driver).toMatchObject({ type: "done", reason: "tool_use" });
    });

    it(`${row.driver}: F2 empty args on an unterminated stream do not run`, async () => {
      const events = await row.empty();
      expect(published(events), row.driver).toBe(false);
      expect(events.some((event) => event.type === "done"), row.driver).toBe(false);
      expect(cutoff(events)?.retryable, row.driver).toBe(false);
    });

    it(`${row.driver}: F2 a scalar argument prefix on an unterminated stream does not run`, async () => {
      const events = await row.scalar();
      expect(published(events), row.driver).toBe(false);
      expect(events.some((event) => event.type === "done"), row.driver).toBe(false);
      expect(cutoff(events)?.retryable, row.driver).toBe(false);
    });

    it(`${row.driver}: F2 a terminated stream with no argument bytes still runs`, async () => {
      const events = await row.terminatedEmpty();
      expect(published(events), row.driver).toBe(true);
      const ended = events.find((event) => event.type === "tool_call_end");
      expect(ended?.type === "tool_call_end" && ended.toolCall.args, row.driver).toEqual({});
      expect(cutoff(events), row.driver).toBeUndefined();
    });

    it(`${row.driver}: I3 strict and normal terminals stay as they are`, async () => {
      const strictEvents = await row.strict();
      expect(published(strictEvents), row.driver).toBe(false);
      expect(strictEvents.at(-1)?.type === "error" && strictEvents.at(-1)).toMatchObject({
        kind: "premature_end",
      });
      const terminalEvents = await row.terminal();
      expect(published(terminalEvents), row.driver).toBe(true);
      expect(terminalEvents.at(-1), row.driver).toMatchObject({ type: "done", reason: "tool_use" });
      expect(cutoff(terminalEvents), row.driver).toBeUndefined();
    });
  }
});

describe("lenient flush of an open call", () => {
  it("drops an empty buffer and a non-object prefix, and keeps a finished {}", () => {
    const empty = new ToolCallAccumulator();
    empty.processChunk({ index: 0, id: "call_empty", name: "read_file" });
    expect(empty.flush({ allowRepair: false })).toEqual({ calls: [], droppedIds: ["call_empty"] });

    const spaces = new ToolCallAccumulator();
    spaces.processChunk({ index: 0, id: "call_spaces", name: "read_file", argsDelta: "   " });
    expect(spaces.flush({ allowRepair: false }).droppedIds).toEqual(["call_spaces"]);

    const number = new ToolCallAccumulator();
    number.processChunk({ index: 0, id: "call_num", name: "read_file", argsDelta: "12" });
    expect(number.flush({ allowRepair: false })).toEqual({ calls: [], droppedIds: ["call_num"] });

    const flag = new ToolCallAccumulator();
    flag.processChunk({ index: 0, id: "call_bool", name: "read_file", argsDelta: "true" });
    expect(flag.flush({ allowRepair: false }).droppedIds).toEqual(["call_bool"]);

    const object = new ToolCallAccumulator();
    object.processChunk({ index: 0, id: "call_obj", name: "read_file", argsDelta: "{}" });
    const kept = object.flush({ allowRepair: false });
    expect(kept.droppedIds).toEqual([]);
    expect(kept.calls[0]?.args).toEqual({});

    const finished = new ToolCallAccumulator();
    finished.processChunk({ index: 0, id: "call_done", name: "read_file" });
    const terminated = finished.flush();
    expect(terminated.droppedIds).toEqual([]);
    expect(terminated.calls[0]?.args).toEqual({});
  });
});

describe("OpenAI frames after finish_reason", () => {
  it("keeps tool-argument deltas that arrive after finish_reason until the trailer", async () => {
    const body = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":".ts\\"}"}}]}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    withFetch(body);
    const events = await collect(new OpenAICompatibleDriver().stream(req("openai", true), auth));
    const ended = events.find((event) => event.type === "tool_call_end");
    expect(ended?.type === "tool_call_end" && ended.toolCall.args).toEqual({ path: "a.ts" });
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
    expect(events.some((event) => event.type === "usage")).toBe(true);
  });

  it("keeps content deltas that arrive after finish_reason", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"A"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"C"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    withFetch(body);
    const events = await collect(new OpenAICompatibleDriver().stream(req("openai", true), auth));
    expect(textOf(events)).toBe("ABC");
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop", message: { content: "ABC" } });
  });

  it("still ends on a usage-only trailer and on [DONE]", async () => {
    const body = [
      'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    withFetch(body);
    const events = await collect(new OpenAICompatibleDriver().stream(req("openai", true), auth));
    expect(textOf(events)).toBe("Hi");
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(events.some((event) => event.type === "usage")).toBe(true);
  });
});

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function readSse(chunks: Uint8Array[]): Promise<string[]> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const out: string[] = [];
  for await (const event of parseSseStream(stream)) out.push(event.data);
  return out;
}

describe("SSE tail and CR", () => {
  it("does not dispatch a final line that was cut off mid-token", async () => {
    expect(await readSse([encode("data: 12")])).toEqual([]);
  });

  it("does not dispatch a multi-line event whose last line is partial", async () => {
    expect(await readSse([encode("data: hello\ndata: wor")])).toEqual([]);
  });

  it("dispatches data: [DONE] when the line is terminated and the blank line is missing", async () => {
    expect(await readSse([encode("data: [DONE]\n")])).toEqual(["[DONE]"]);
  });

  it("dispatches an event whose lines are terminated and only the blank line is missing", async () => {
    expect(await readSse([encode("event: message\ndata: hello\n")])).toEqual(["hello"]);
  });

  it("dispatches a CR-CR terminal without waiting for more bytes", async () => {
    let opened = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!opened) {
          opened = true;
          controller.enqueue(encode("data: [DONE]\r\r"));
          return;
        }
        return new Promise(() => {});
      },
    });
    const iter = parseSseStream(stream)[Symbol.asyncIterator]();
    const raced = await Promise.race([
      iter.next().then((result) => result.value?.data ?? "missing"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 200)),
    ]);
    expect(raced).toBe("[DONE]");
  });
});

describe("Anthropic stop reasons", () => {
  it("maps model_context_window_exceeded to length", async () => {
    const body = sse([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Partial" } },
      { type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
    withFetch(body);
    const events = await collect(new AnthropicDriver().stream(req("anthropic", true), auth));
    expect(textOf(events)).toBe("Partial");
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "length",
      message: { content: "Partial" },
    });
  });

  it("emits an error when a refusal has no text and only a tool block", async () => {
    const body = sse([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
      { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
    withFetch(body);
    const events = await collect(new AnthropicDriver().stream(req("anthropic", true), auth));
    expect(published(events)).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const error = events.find((event) => event.type === "error");
    expect(error?.type === "error" && error.error.message).toBe("The model declined to answer");
    expect(error?.type === "error" && error.retryable).toBe(false);
  });

  it("keeps refusal text as a normal stop", async () => {
    const body = sse([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "No." } },
      { type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
    withFetch(body);
    const events = await collect(new AnthropicDriver().stream(req("anthropic", true), auth));
    expect(events.at(-1)).toMatchObject({
      type: "done",
      reason: "stop",
      message: { content: "No." },
    });
  });
});

describe("Responses argument deltas and error status", () => {
  it("ignores argument deltas after the call was opened and closed", async () => {
    const frames = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" },
      },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: '{"path":"a.ts"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0 },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: "extra" },
      { type: "response.completed", response: { status: "completed" } },
    ];
    withFetch(sse(frames));
    const events = await collect(new OpenAIResponsesDriver().stream(req("openai", false), auth));
    expect(events.some((event) => event.type === "error")).toBe(false);
    const ended = events.find((event) => event.type === "tool_call_end");
    expect(ended?.type === "tool_call_end" && ended.toolCall.args).toEqual({ path: "a.ts" });
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
  });

  it("maps rate_limit_exceeded on an in-stream error to 429", async () => {
    withFetch(sse([{ type: "error", code: "rate_limit_exceeded", message: "slow down" }]));
    const events = await collect(new OpenAIResponsesDriver().stream(req("openai", false), auth));
    const error = events.at(-1);
    expect(error?.type === "error" && error.status).toBe(429);
    expect(error?.type === "error" && error.error.message).toBe("slow down");
  });

  it("maps server_error on response.failed to 500", async () => {
    withFetch(sse([{
      type: "response.failed",
      response: { status: "failed", error: { code: "server_error", message: "boom" } },
    }]));
    const events = await collect(new OpenAIResponsesDriver().stream(req("openai", true), auth));
    const error = events.at(-1);
    expect(error?.type === "error" && error.status).toBe(500);
    expect(error?.type === "error" && error.error.message).toBe("boom");
  });

  it("maps insufficient_quota to 429 without reading the message text", async () => {
    withFetch(sse([{ type: "error", code: "insufficient_quota", message: "quota" }]));
    const events = await collect(new OpenAIResponsesDriver().stream(req("openai", false), auth));
    const error = events.at(-1);
    expect(error?.type === "error" && error.status).toBe(429);
  });
});

describe("hosted endpoint scheme", () => {
  it("treats a scheme-less built-in host as https and hosted", () => {
    expect(isDefaultHostedEndpoint("openai", "api.openai.com/v1")).toBe(true);
    expect(resolveStreamEndMode("openai", "auto", "api.openai.com/v1")).toBe("strict");
    expect(resolveLlmStreamTimeouts({
      provider: "openai",
      baseUrl: "api.openai.com/v1",
    }).connectTimeoutMs).toBe(60_000);
  });

  it("still rejects an explicit http scheme against the https registry host", () => {
    expect(isDefaultHostedEndpoint("openai", "http://api.openai.com/v1")).toBe(false);
    expect(resolveStreamEndMode("openai", "auto", "http://api.openai.com/v1")).toBe("lenient");
  });
});
