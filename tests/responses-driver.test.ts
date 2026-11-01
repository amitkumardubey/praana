import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { OpenAIResponsesDriver } from "../src/llm/drivers/responses.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";
import { APP_VERSION } from "../src/app-banner.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { streamLlmResponse } from "../src/llm/stream.js";
import { resetCredentialStoreForTests, setOAuthToken } from "../src/credentials.js";

const jwt = (id = "jwt-account") => `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.sig`;
const req: StreamRequest = { provider: "openai-codex", model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] };
const completed = { type: "response.completed", response: { status: "completed" } };
let originalFetch: typeof fetch;
let calls: Array<{ url: string; init: RequestInit }>;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = (async () => { throw new Error("Unexpected network call"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

async function run(request: StreamRequest = req, auth: ResolvedAuth = { bearerToken: jwt() }, frames: unknown[] = [completed]): Promise<StreamEvent[]> {
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const sse = frames.map((frame) => typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`).join("");
    return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  const events: StreamEvent[] = [];
  for await (const event of new OpenAIResponsesDriver().stream(request, auth)) events.push(event);
  return events;
}

describe("Codex outgoing request", () => {
  it("protects required headers and sends only the supported Codex body fields", async () => {
    const token = jwt();
    await run({ ...req, systemPrompt: "Follow project rules.", maxTokens: 42, temperature: 0.2, reasoningEffort: "high", headers: {
      authorization: "Bearer wrong", "CHATGPT-ACCOUNT-ID": "wrong", ORIGINATOR: "pi", "openai-beta": "wrong", ACCEPT: "application/json", "user-agent": "wrong", "content-type": "text/plain", "x-custom": "kept",
    } }, { apiKey: token, headers: { "chatgpt-account-id": "stored-account", originator: "wrong", Accept: "wrong" } });
    expect(calls[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(Object.fromEntries(new Headers(calls[0]!.init.headers))).toEqual({
      authorization: `Bearer ${token}`, "chatgpt-account-id": "stored-account", originator: "praana", "openai-beta": "responses=experimental", accept: "text/event-stream", "user-agent": `praana/${APP_VERSION.replace(/^v/, "")}`, "content-type": "application/json", "x-custom": "kept",
    });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ model: "gpt-5.4", input: [{ role: "user", content: "hi" }], stream: true, store: false, instructions: "Follow project rules.", reasoning: { effort: "high" } });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_output_tokens");
  });
  it.each([undefined, "", "  \n "])("provides non-empty instructions for %j", async (systemPrompt) => {
    await run({ ...req, systemPrompt, maxTokens: 100 });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.instructions).toBe("You are a helpful assistant.");
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("max_output_tokens");
  });
  it("uses a stored account id when the access token has no chatgpt_account_id claim", async () => {
    const legacy = "e30.e30.sig";
    await run(
      { ...req, apiKey: legacy, headers: { "chatgpt-account-id": "stored-account" } },
      { bearerToken: legacy, headers: { "chatgpt-account-id": "stored-account" } },
    );
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${legacy}`);
    expect(headers.get("chatgpt-account-id")).toBe("stored-account");
  });
  it("prefers a stored account id that differs from the access token claim", async () => {
    const token = jwt("claim-account");
    await run(
      { ...req, apiKey: token },
      { bearerToken: token, headers: { "chatgpt-account-id": "stored-account" } },
    );
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("chatgpt-account-id")).toBe("stored-account");
  });
  it("derives the account id from an override token when the caller sends no account header", async () => {
    await run(
      { ...req, apiKey: jwt("override-account") },
      { bearerToken: jwt("stored-account"), headers: { "chatgpt-account-id": "stored-account" } },
    );
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${jwt("override-account")}`);
    expect(headers.get("chatgpt-account-id")).toBe("override-account");
  });
  it("derives the account id from the actual bearer JWT when no OAuth header is available", async () => {
    await run(req, { apiKey: jwt("other-api-key"), bearerToken: jwt("bearer-account") });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${jwt("bearer-account")}`);
    expect(headers.get("chatgpt-account-id")).toBe("bearer-account");
  });
  it.each(["apiKey", "bearerToken"] as const)("uses the explicit %s token and its account, not stored credentials", async (field) => {
    await run({ ...req, [field]: jwt("override-account") }, { apiKey: jwt("stored-api"), bearerToken: jwt("stored-bearer"), headers: { "chatgpt-account-id": "stored-account", Authorization: `Bearer ${jwt("header-token")}` } });
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${jwt("override-account")}`);
    expect(headers.get("chatgpt-account-id")).toBe("override-account");
  });
  it.each([{}, { bearerToken: "legacy-paste" }, { bearerToken: "e30.e30.sig" }, { bearerToken: "opaque-token" }])("yields a non-retryable credential error for %j", async (auth) => {
    const events = await run(req, auth);
    expect(calls).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["error"]);
    const error = events[0];
    expect(error?.type === "error" && error.retryable).toBe(false);
    expect(error?.type === "error" && error.error.message).toMatch(/run \/login openai-codex again/);
  });
  it("does not borrow a stored account id when an explicit override is invalid", async () => {
    const events = await run({ ...req, apiKey: "invalid-override" }, { bearerToken: jwt(), headers: { "chatgpt-account-id": "stored-account" } });
    expect(calls).toEqual([]);
    expect(events.map((event) => event.type)).toEqual(["error"]);
    const error = events[0];
    expect(error?.type === "error" && error.retryable).toBe(false);
    expect(error?.type === "error" && error.error.message).toMatch(/run \/login openai-codex again/);
  });
});

function eventSequence(events: StreamEvent[]): string {
  return `${events.map((event) => JSON.stringify(event.type === "error"
    ? { type: "error", message: event.error.message, name: event.error.name, retryable: event.retryable, status: event.status ?? null }
    : event)).join("\n")}\n`;
}

async function streamEvents(driver: { stream: OpenAIResponsesDriver["stream"] }, sse: string, provider: string): Promise<string> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
  try {
    const events: StreamEvent[] = [];
    const request: StreamRequest = { provider, model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] };
    const auth: ResolvedAuth = provider === "openai-codex" ? { bearerToken: jwt() } : { apiKey: "synthetic-openai-key" };
    for await (const event of driver.stream(request, auth)) events.push(event);
    return eventSequence(events);
  } finally {
    globalThis.fetch = previous;
  }
}

async function mainResponsesDriver(): Promise<OpenAIResponsesDriver> {
  const repo = join(import.meta.dir, "..");
  const source = execFileSync("git", ["show", "main:src/llm/drivers/responses.ts"], { cwd: repo, encoding: "utf8" });
  const scratch = mkdtempSync(join(tmpdir(), "praana-responses-main-"));
  try {
    const file = join(scratch, "responses-main.ts");
    const driversDir = join(repo, "src/llm/drivers");
    writeFileSync(file, source.replace(/from "(\.[^"]+)"/g, (_match, spec: string) => `from ${JSON.stringify(join(driversDir, spec))}`));
    const loaded = await import(`${pathToFileURL(file).href}?main-responses`) as { OpenAIResponsesDriver: new () => OpenAIResponsesDriver };
    return new loaded.OpenAIResponsesDriver();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const OPENAI_MAIN_STREAMS = [
  "incomplete-length.sse",
  "incomplete-content-filter.sse",
  "incomplete-tool-arguments.sse",
  "disconnect-before-created.sse",
  "disconnect-after-reasoning.sse",
  "response-failed.sse",
];

describe("Responses stream termination", () => {
  it.each([
    { type: "error", message: "Backend unavailable" },
    { type: "error", error: { message: "Backend unavailable" } },
    { type: "response.failed", response: { status: "failed", error: { message: "Backend unavailable" } } },
  ])("Codex emits backend errors instead of done for %j", async (frame) => {
    const events = await run(req, { bearerToken: jwt() }, [{ type: "response.output_text.delta", delta: "partial" }, frame]);
    expect(events.map((event) => event.type)).toEqual(["text_delta", "error"]);
    const error = events[1];
    expect(error?.type === "error" && error.error.message).toBe("Backend unavailable");
  });

  it("Codex finishes max_output_tokens as length and keeps the partial output", async () => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    expect(events).toEqual([
      { type: "text_delta", delta: "partial" },
      { type: "done", reason: "length", message: { role: "assistant", content: "partial" } },
    ]);
  });

  it("Codex errors when max_output_tokens cuts off a tool call", async () => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{" } },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    expect(events.map((event) => event.type)).toEqual(["tool_call_start", "error"]);
    const error = events[1];
    expect(error?.type === "error" && error.error.message).toBe("The response was cut off while the model was calling a tool");
    expect(events.some((event) => event.type === "done")).toBe(false);
  });

  it.each(["failed", "cancelled"] as const)("Codex treats response.done status %s as a failure", async (status) => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.done", response: { status, error: { message: "Backend unavailable" } } },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const last = events.at(-1);
    expect(last?.type === "error" && last.error.message).toBe("Backend unavailable");
  });

  it("Codex treats response.done with an error payload as a failure", async () => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.done", response: { status: "completed" }, error: { message: "Backend unavailable" } },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const last = events.at(-1);
    expect(last?.type === "error" && last.error.message).toBe("Backend unavailable");
  });

  it("publishes a finished tool call when a later text cutoff hits the output limit", async () => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
      { type: "response.function_call_arguments.done", output_index: 0 },
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    const ended = events.find((event) => event.type === "tool_call_end");
    expect(ended?.type === "tool_call_end" && ended.toolCall.name).toBe("read_file");
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.reason).toBe("tool_use");
      expect(done.message.toolCalls?.[0]?.name).toBe("read_file");
      expect(done.message.content).toBe("partial");
    }
  });

  it("Codex applies the output-limit cutoff to response.done and response.completed", async () => {
    for (const frame of [
      { type: "response.done", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
      { type: "response.completed", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]) {
      const events = await run(req, { bearerToken: jwt() }, [
        { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{" } },
        frame,
      ]);
      expect(events.map((event) => event.type)).toEqual(["tool_call_start", "error"]);
      const error = events[1];
      expect(error?.type === "error" && error.error.message).toBe("The response was cut off while the model was calling a tool");
    }
  });

  it("Codex errors when response.done is incomplete for a reason other than the output limit", async () => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.done", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } } },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const last = events.at(-1);
    expect(last?.type === "error" && last.error.message).toBe("content_filter");
  });

  it("does not close a still-streaming call when a done event omits output_index", async () => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc-a", call_id: "call-a", name: "read_file", arguments: "{" } },
      { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc-b", call_id: "call-b", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.done", output_index: 1 },
      { type: "response.function_call_arguments.done" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    expect(events.map((event) => event.type)).toEqual(["tool_call_start", "tool_call_start", "error"]);
    const error = events.at(-1);
    expect(error?.type === "error" && error.error.message).toBe("The response was cut off while the model was calling a tool");
  });

  it("closes each finished call by id when output_index is missing", async () => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_item.added", item: { type: "function_call", id: "fc-a", call_id: "call-a", name: "read_file", arguments: "{\"path\":\"a.ts\"}" } },
      { type: "response.output_item.added", item: { type: "function_call", id: "fc-b", call_id: "call-b", name: "shell", arguments: "{\"cmd\":\"ls\"}" } },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc-a", call_id: "call-a" } },
      { type: "response.output_item.done", item: { type: "function_call", id: "fc-b", call_id: "call-b" } },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } },
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.filter((event) => event.type === "tool_call_end")).toHaveLength(2);
    const done = events.at(-1);
    expect(done?.type === "done" && done.reason).toBe("tool_use");
  });

  it.each(["content_filter", "server_error"])("Codex errors on incomplete reason %s", async (reason) => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason } } },
    ]);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const last = events.at(-1);
    expect(last?.type === "error" && last.error.message).toBe(reason);
  });

  it.each([
    ["response.completed", completed],
    ["response.done", { type: "response.done", response: { status: "completed" } }],
    ["[DONE]", "data: [DONE]\n\n"],
  ] as const)("Codex treats %s as a terminal event", async (_name, frame) => {
    const events = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_text.delta", delta: "Hello" },
      frame,
    ]);
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done", reason: "stop", message: { role: "assistant", content: "Hello" } });
  });

  it.each([{ frames: [] }, { frames: [{ type: "response.output_text.delta", delta: "partial" }] }])("Codex rejects EOF without a terminal Responses event (%j)", async ({ frames }) => {
    const events = await run(req, { bearerToken: jwt() }, frames);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const last = events.at(-1);
    expect(last?.type === "error" && last.error.message).toMatch(/without.*terminal/);
  });

  it("plain OpenAI response.done and [DONE] match main byte for byte", async () => {
    const mainDriver = await mainResponsesDriver();
    const current = new OpenAIResponsesDriver();
    const streams = [
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi" })}\n\ndata: ${JSON.stringify({ type: "response.done", response: { status: "completed" } })}\n\n`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Hi" })}\n\ndata: [DONE]\n\n`,
    ];
    for (const provider of ["openai", "openai-responses"]) {
      for (const sse of streams) {
        const mainBytes = await streamEvents(mainDriver, sse, provider);
        const currentBytes = await streamEvents(current, sse, provider);
        expect(currentBytes, provider).toBe(mainBytes);
      }
    }
  });

  it("plain OpenAI incomplete and unterminated streams match main byte for byte", async () => {
    const mainDriver = await mainResponsesDriver();
    const current = new OpenAIResponsesDriver();
    const root = join(import.meta.dir, "../tests/fixtures/rust-v2/providers/v1/openai-responses/streams");
    for (const provider of ["openai", "openai-responses"]) {
      for (const name of OPENAI_MAIN_STREAMS) {
        const sse = readFileSync(join(root, name), "utf8");
        const mainBytes = await streamEvents(mainDriver, sse, provider);
        const currentBytes = await streamEvents(current, sse, provider);
        expect(currentBytes, `${provider} ${name}`).toBe(mainBytes);
      }
    }
  });

  it("reads usage nested under response.completed and response.incomplete", async () => {
    const nested = {
      input_tokens: 11,
      output_tokens: 7,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 4 },
      output_tokens_details: { reasoning_tokens: 3 },
    };
    const mapped = { input: 11, output: 7, totalTokens: 18 };
    const completedEvents = await run({ ...req, provider: "openai" }, { apiKey: "synthetic-openai-key" }, [
      { type: "response.output_text.delta", delta: "Hi" },
      { type: "response.completed", response: { status: "completed", usage: nested } },
    ]);
    expect(completedEvents).toContainEqual({ type: "usage", usage: mapped });
    const incompleteEvents = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: nested } },
    ]);
    expect(incompleteEvents).toContainEqual({ type: "usage", usage: mapped });
    expect(incompleteEvents.at(-1)).toEqual({ type: "done", reason: "length", message: { role: "assistant", content: "partial" } });
  });

  it("emits top-level and nested usage, and does not zero-fill empty or partial usage", async () => {
    const topLevel = await run({ ...req, provider: "openai" }, { apiKey: "synthetic-openai-key" }, [
      { type: "response.output_text.delta", delta: "Hi" },
      { type: "response.completed", response: { status: "completed" }, usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } },
    ]);
    expect(topLevel.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { input: 4, output: 1, totalTokens: 5 } },
    ]);

    const nestedOnly = await run({ ...req, provider: "openai" }, { apiKey: "synthetic-openai-key" }, [
      { type: "response.completed", response: { status: "completed", usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } } },
    ]);
    expect(nestedOnly.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { input: 6, output: 2, totalTokens: 8 } },
    ]);

    const emptyNestedFallsThrough = await run({ ...req, provider: "openai" }, { apiKey: "synthetic-openai-key" }, [
      { type: "response.completed", response: { status: "completed", usage: {} }, usage: { input_tokens: 8, output_tokens: 1, total_tokens: 9 } },
    ]);
    expect(emptyNestedFallsThrough.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { input: 8, output: 1, totalTokens: 9 } },
    ]);

    const merged = await run(req, { bearerToken: jwt() }, [
      { type: "response.output_text.delta", delta: "Hi", usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
      { usage: {} },
      { usage: { output_tokens: 4 } },
      { response: { usage: {} } },
      completed,
    ]);
    expect(merged.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { input: 10, output: 1, totalTokens: 11 } },
      { type: "usage", usage: { input: 10, output: 4, totalTokens: 11 } },
    ]);
  });

  it("preserves valid OpenAI text, reasoning, tools, usage and final message", async () => {
    const events = await run({ ...req, provider: "openai" }, { apiKey: "synthetic-openai-key" }, [
      { type: "response.reasoning_text.delta", delta: "Thinking" },
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call-1", name: "read_file" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"a.ts"}' },
      { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }, completed,
    ]);
    const toolCall = { id: "call-1", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' };
    expect(events).toEqual([
      { type: "thinking_delta", delta: "Thinking" }, { type: "text_delta", delta: "Hello" },
      { type: "tool_call_start", id: "call-1", name: "read_file" }, { type: "tool_call_delta", id: "call-1", argsDelta: '{"path":"a.ts"}' },
      { type: "usage", usage: { input: 3, output: 2, totalTokens: 5 } }, { type: "tool_call_end", toolCall },
      { type: "done", reason: "tool_use", message: { role: "assistant", content: "Hello", toolCalls: [toolCall] } },
    ]);
  });
});

it("keeps the ordinary OpenAI Responses request byte-identical", async () => {
  const signal = new AbortController().signal;
  await run({ ...req, provider: "openai", systemPrompt: "System", maxTokens: 42, temperature: 0.25, reasoningEffort: "low", signal,
    headers: { "X-Caller": "caller" }, tools: [{ name: "read_file", description: "Read", parameters: { type: "object" } }],
  }, { apiKey: "synthetic-openai-key", headers: { "X-Auth": "auth" } });
  expect(calls).toEqual([{ url: "https://api.openai.com/v1/responses", init: {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", Authorization: "Bearer synthetic-openai-key", "X-Caller": "caller", "X-Auth": "auth" },
    body: '{"model":"gpt-5.4","input":[{"role":"user","content":"hi"}],"stream":true,"instructions":"System","tools":[{"type":"function","name":"read_file","description":"Read","parameters":{"type":"object"}}],"tool_choice":"auto","temperature":0.25,"max_output_tokens":42,"reasoning":{"effort":"low"}}',
  } }]);
  await run({ ...req, provider: "openai" }, { apiKey: "synthetic-openai-key" });
  expect(calls[1]!.init.body).toBe('{"model":"gpt-5.4","input":[{"role":"user","content":"hi"}],"stream":true}');
});

it("keeps request-level token overrides consistent through the real stream facade", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-responses-facade-"));
  const previous = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = home;
  resetCredentialStoreForTests();
  try {
    setOAuthToken("openai-codex", { access: jwt("stored"), refresh: "synthetic-refresh", expires: Date.now() + 3600_000, accountId: "stored" });
    let sent: Headers | undefined;
    globalThis.fetch = (async (_url, init) => {
      sent = new Headers(init?.headers);
      return new Response(`data: ${JSON.stringify(completed)}\n\n`);
    }) as typeof fetch;
    const events: StreamEvent[] = [];
    for await (const event of streamLlmResponse({
      ...req, apiKey: jwt("explicit"),
      headers: { Authorization: "Bearer wrong", "chatgpt-account-id": "wrong", originator: "pi", Accept: "wrong" },
    })) events.push(event);
    expect(sent?.get("Authorization")).toBe(`Bearer ${jwt("explicit")}`);
    expect(sent?.get("chatgpt-account-id")).toBe("explicit");
    expect(sent?.get("originator")).toBe("praana");
    expect(sent?.get("Accept")).toBe("text/event-stream");
    expect(events.at(-1)?.type).toBe("done");
  } finally {
    resetCredentialStoreForTests();
    if (previous === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

it("sends the saved account id when the turn passes the stored token as the request key", async () => {
  const home = mkdtempSync(join(tmpdir(), "praana-responses-account-"));
  const previous = process.env.PRAANA_HOME;
  process.env.PRAANA_HOME = home;
  resetCredentialStoreForTests();
  const legacy = "e30.e30.sig";
  const claimed = jwt("claim-account");
  try {
    for (const [access, accountId] of [[legacy, "stored-legacy"], [claimed, "stored-id"]] as const) {
      setOAuthToken("openai-codex", {
        access,
        refresh: "synthetic-refresh",
        expires: Date.now() + 3_600_000,
        accountId,
      });
      let sent: Headers | undefined;
      globalThis.fetch = (async (_url, init) => {
        sent = new Headers(init?.headers);
        return new Response(`data: ${JSON.stringify(completed)}\n\n`);
      }) as typeof fetch;
      const events: StreamEvent[] = [];
      for await (const event of streamLlmResponse({
        ...req,
        apiKey: access,
        headers: { "chatgpt-account-id": accountId },
      })) events.push(event);
      expect(sent?.get("Authorization")).toBe(`Bearer ${access}`);
      expect(sent?.get("chatgpt-account-id")).toBe(accountId);
      expect(events.at(-1)?.type).toBe("done");
    }
  } finally {
    resetCredentialStoreForTests();
    if (previous === undefined) delete process.env.PRAANA_HOME;
    else process.env.PRAANA_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
