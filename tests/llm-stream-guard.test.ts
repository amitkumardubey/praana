import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigWarnings, loadConfig } from "../src/config.js";
import { createTestLogger, getAppLogger, setAppLogger, type PraanaLogger } from "../src/logger.js";
import { AnthropicDriver } from "../src/llm/drivers/anthropic.js";
import { BedrockDriver } from "../src/llm/drivers/bedrock.js";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { OpenAICompatibleDriver } from "../src/llm/drivers/openai.js";
import type { LlmDriver } from "../src/llm/drivers/base.js";
import { createLlmFetchGuard, readErrorBody } from "../src/llm/stream-guard.js";
import { isRetryableError } from "../src/llm/retry.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;

interface GuardModule {
  streamGuardPendingTimers(): number;
  streamGuardPendingListeners(): number;
  ConnectTimeoutError: new (timeoutMs: number) => Error;
  DEFAULT_CONNECT_TIMEOUT_MS: number;
  DEFAULT_STREAM_IDLE_TIMEOUT_MS: number;
}

async function loadGuard(): Promise<GuardModule | null> {
  try {
    return (await import("../src/llm/stream-guard.js")) as GuardModule;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("stream-guard")) return null;
    throw err;
  }
}

let requestTimeouts: { connectTimeoutMs: number; idleTimeoutMs: number } | null = null;

async function applyTimeouts(connectTimeoutMs: number, idleTimeoutMs: number): Promise<void> {
  requestTimeouts = { connectTimeoutMs, idleTimeoutMs };
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  requestTimeouts = null;
});

function encodeFrame(payload: unknown): Buffer {
  const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const totalLength = payloadBytes.length + 16;
  const buf = Buffer.alloc(totalLength);
  buf.writeUInt32BE(totalLength, 0);
  buf.writeUInt32BE(0, 4);
  buf.writeUInt32BE(0, 8);
  payloadBytes.copy(buf, 12);
  buf.writeUInt32BE(0, totalLength - 4);
  return buf;
}

const OPENAI_TEXT = 'data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n';
const OPENAI_DONE =
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
const ANTHROPIC_TEXT =
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial"}}\n\n';
const ANTHROPIC_DONE = 'data: {"type":"message_stop"}\n\n';
const GOOGLE_TEXT =
  'data: {"candidates":[{"content":{"parts":[{"text":"Partial"}]}}]}\n\n';
const GOOGLE_DONE = 'data: {"candidates":[{"finishReason":"STOP"}]}\n\n';

function bedrockText(): Uint8Array {
  return encodeFrame({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Partial" } } });
}
function bedrockDone(): Uint8Array {
  return encodeFrame({ messageStop: { stopReason: "end_turn" } });
}

interface DriverCase {
  name: string;
  driver: LlmDriver;
  req: StreamRequest;
  auth: ResolvedAuth;
  first: BodyInit;
  terminal: BodyInit;
}

function cases(): DriverCase[] {
  const auth = { apiKey: "test-key" };
  const hi = (provider: string): StreamRequest => ({
    model: "m",
    provider,
    messages: [{ role: "user", content: "hi" }],
  });
  return [
    {
      name: "anthropic",
      driver: new AnthropicDriver(),
      req: hi("anthropic"),
      auth,
      first: ANTHROPIC_TEXT,
      terminal: ANTHROPIC_TEXT + ANTHROPIC_DONE,
    },
    {
      name: "openai",
      driver: new OpenAICompatibleDriver(),
      req: hi("openai"),
      auth,
      first: OPENAI_TEXT,
      terminal: OPENAI_TEXT + OPENAI_DONE,
    },
    {
      name: "google",
      driver: new GoogleDriver(),
      req: hi("google"),
      auth,
      first: GOOGLE_TEXT,
      terminal: GOOGLE_TEXT + GOOGLE_DONE,
    },
    {
      name: "bedrock",
      driver: new BedrockDriver(),
      req: { ...hi("amazon-bedrock"), region: "us-east-1" },
      auth: { bearerToken: "bearer-fixture" },
      first: bedrockText(),
      terminal: Buffer.concat([bedrockText(), bedrockDone()]),
    },
  ];
}

async function collect(driver: LlmDriver, req: StreamRequest, auth: ResolvedAuth): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const timed = requestTimeouts ? { ...req, ...requestTimeouts } : req;
  for await (const ev of driver.stream(timed, auth)) events.push(ev);
  return events;
}

function accelerateLongTimers(): () => void {
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const delay = typeof ms === "number" && ms >= 500 ? 1 : ms;
    return originalSetTimeout(fn as TimerHandler, delay as number, ...(args as []));
  }) as typeof setTimeout;
  return () => {
    globalThis.setTimeout = originalSetTimeout;
  };
}

describe("llm stream timeouts", () => {
  for (const spec of cases()) {
    it(`${spec.name}: stalled body ends as timeout and aborts the fetch signal`, async () => {
      await applyTimeouts(0, 40);
      let signal: AbortSignal | undefined;
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const bytes = typeof spec.first === "string"
              ? new TextEncoder().encode(spec.first)
              : new Uint8Array(spec.first as Uint8Array);
            controller.enqueue(bytes);
            const killer = setTimeout(() => controller.close(), 250);
            const onAbort = () => {
              clearTimeout(killer);
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          },
        });
        return new Response(body, { status: 200 });
      }) as typeof fetch;

      const events = await collect(spec.driver, spec.req, spec.auth);
      expect(events.some((ev) => ev.type === "text_delta" && ev.delta === "Partial")).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        reason: "timeout",
        message: { role: "assistant", content: "Partial" },
      });
      expect(signal?.aborted).toBe(true);
    });

    it(`${spec.name}: user abort is abort, not timeout`, async () => {
      await applyTimeouts(0, 5_000);
      const user = new AbortController();
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const bytes = typeof spec.first === "string"
              ? new TextEncoder().encode(spec.first)
              : new Uint8Array(spec.first as Uint8Array);
            controller.enqueue(bytes);
            const onAbort = () => {
              controller.error(new DOMException("The operation was aborted.", "AbortError"));
            };
            if (init?.signal?.aborted) onAbort();
            else init?.signal?.addEventListener("abort", onAbort, { once: true });
          },
        });
        return new Response(body, { status: 200 });
      }) as typeof fetch;
      setTimeout(() => user.abort(), 20);

      const events = await collect(spec.driver, { ...spec.req, signal: user.signal }, spec.auth);
      expect(events.some((ev) => ev.type === "text_delta")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "done", reason: "abort" });
      expect(events.some((ev) => ev.type === "done" && ev.reason === "timeout")).toBe(false);
    });

    it(`${spec.name}: connect stall is retried then reported as a timeout error`, async () => {
      await applyTimeouts(30, 0);
      const restore = accelerateLongTimers();
      let calls = 0;
      try {
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
          calls += 1;
          const signal = init?.signal;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => resolve(), 200);
            const onAbort = () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "AbortError"));
            };
            if (!signal) return;
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          });
          return new Response(spec.terminal, { status: 200 });
        }) as typeof fetch;

        const events = await collect(spec.driver, spec.req, spec.auth);
        const error = events.find((ev) => ev.type === "error");
        expect(error && error.type === "error" ? error.error.message : "").toContain("ETIMEDOUT");
        expect(error && error.type === "error" ? error.error.message : "").toContain("30");
        expect(calls).toBe(2);
        expect(events.some((ev) => ev.type === "done" && ev.reason === "stop")).toBe(false);
      } finally {
        restore();
      }
    });
  }

  it("does not cut a stream whose bytes arrive under the idle limit, including comment keep-alives", async () => {
    await applyTimeouts(0, 100);
    const enc = new TextEncoder();
    const parts = [
      OPENAI_TEXT,
      ": keep-alive\n\n",
      ": keep-alive\n\n",
      OPENAI_DONE,
    ];
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const part of parts) {
            await Bun.sleep(35);
            controller.enqueue(enc.encode(part));
          }
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const events = await collect(
      new OpenAICompatibleDriver(),
      { model: "m", provider: "openai", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "test-key" },
    );
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
    expect(events.some((ev) => ev.type === "text_delta" && ev.delta === "Partial")).toBe(true);
  });

  it("treats 0 as disabling connect and idle timers", async () => {
    await applyTimeouts(0, 0);
    const enc = new TextEncoder();
    globalThis.fetch = (async () => {
      await Bun.sleep(50);
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(enc.encode(OPENAI_TEXT));
          await Bun.sleep(50);
          controller.enqueue(enc.encode(OPENAI_DONE));
          controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;

    const events = await collect(
      new OpenAICompatibleDriver(),
      { model: "m", provider: "openai", messages: [{ role: "user", content: "hi" }] },
      { apiKey: "test-key" },
    );
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "stop" });
  });

  it("clears guard timers and abort listeners after a normal stream", async () => {
    const guard = await loadGuard();
    expect(guard).not.toBeNull();
    await applyTimeouts(60_000, 120_000);
    const user = new AbortController();
    globalThis.fetch = (async () =>
      new Response(OPENAI_TEXT + OPENAI_DONE, { status: 200 })) as typeof fetch;
    await collect(
      new OpenAICompatibleDriver(),
      {
        model: "m",
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
        signal: user.signal,
      },
      { apiKey: "test-key" },
    );
    expect(guard!.streamGuardPendingTimers()).toBe(0);
    expect(guard!.streamGuardPendingListeners()).toBe(0);
  });

  it("does not idle-abort while the consumer is still holding a delivered chunk", async () => {
    const enc = new TextEncoder();
    let push: ((chunk: Uint8Array | null) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => {
          if (chunk === null) controller.close();
          else controller.enqueue(chunk);
        };
      },
    });
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(body);
    }) as typeof fetch;

    const guard = createLlmFetchGuard({ connectTimeoutMs: 0, idleTimeoutMs: 40 });
    const res = await guard.fetch("https://example.test/v1/messages");
    const reader = guard.wrapBody(res.body!).getReader();
    const firstRead = reader.read();
    push!(enc.encode("a"));
    const first = await firstRead;
    expect(new TextDecoder().decode(first.value)).toBe("a");
    await Bun.sleep(100);
    expect(signal?.aborted).toBe(false);
    expect(guard.abortKind()).toBeNull();
    const secondRead = reader.read();
    push!(enc.encode("b"));
    push!(null);
    const second = await secondRead;
    expect(second.done).toBe(false);
    expect(new TextDecoder().decode(second.value)).toBe("b");
    const end = await reader.read();
    expect(end.done).toBe(true);
    guard.dispose();
  });

  it("recognises a connect timeout as retryable", async () => {
    const guard = await loadGuard();
    expect(guard).not.toBeNull();
    const err = new guard!.ConnectTimeoutError(1500);
    expect(err.message).toContain("ETIMEDOUT");
    expect(err.message).toContain("1500");
    expect(isRetryableError(err)).toBe(true);
  });
});

describe("error body timeout", () => {
  it("stops reading a body that never arrives", async () => {
    const res = new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
      { status: 502 },
    );
    await expect(readErrorBody(res, 30)).rejects.toThrow(/response body timed out/);
  });

  it("reports a stalled Anthropic error body with the status", async () => {
    await applyTimeouts(0, 40);
    const restore = accelerateLongTimers();
    try {
      globalThis.fetch = (async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 502 })) as typeof fetch;
      const events = await collect(
        new AnthropicDriver(),
        { model: "m", provider: "anthropic", messages: [{ role: "user", content: "hi" }] },
        { apiKey: "test-key" },
      );
      const error = events.find((ev) => ev.type === "error");
      expect(error && error.type === "error" ? error.error.message : "").toContain("502");
      expect(error && error.type === "error" ? error.error.message : "").toContain(
        "response body timed out",
      );
      expect(error && error.type === "error" ? error.status : undefined).toBe(502);
    } finally {
      restore();
    }
  });
});

describe("llm timeout config", () => {
  let dir = "";
  let previousLogger: PraanaLogger;

  beforeEach(() => {
    previousLogger = getAppLogger();
    setAppLogger(createTestLogger(() => {}));
  });

  afterEach(() => {
    setAppLogger(previousLogger);
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
    getConfigWarnings();
  });

  it("defaults connect and idle timeouts when the keys are omitted", async () => {
    dir = mkdtempSync(join(tmpdir(), "praana-llm-timeout-"));
    const path = join(dir, "praana.config.toml");
    writeFileSync(path, '[llm]\nmodel = "m"\n', "utf-8");
    getConfigWarnings();
    const cfg = loadConfig(path);
    expect(getConfigWarnings().some((w) => w.includes("connect_timeout") || w.includes("stream_idle"))).toBe(
      false,
    );
    const guard = await loadGuard();
    expect(cfg.llm.connect_timeout_ms).toBeUndefined();
    expect(cfg.llm.stream_idle_timeout_ms).toBeUndefined();
    expect(guard?.DEFAULT_CONNECT_TIMEOUT_MS).toBe(60_000);
    expect(guard?.DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(300_000);
  });

  it("accepts 0 as a disabled timer", async () => {
    dir = mkdtempSync(join(tmpdir(), "praana-llm-timeout-"));
    const path = join(dir, "praana.config.toml");
    writeFileSync(
      path,
      "[llm]\nconnect_timeout_ms = 0\nstream_idle_timeout_ms = 0\n",
      "utf-8",
    );
    getConfigWarnings();
    const cfg = loadConfig(path);
    expect(getConfigWarnings().some((w) => w.includes("timeout"))).toBe(false);
    expect(cfg.llm.connect_timeout_ms).toBe(0);
    expect(cfg.llm.stream_idle_timeout_ms).toBe(0);
  });

  it("warns and falls back when a timeout is not a non-negative integer", async () => {
    dir = mkdtempSync(join(tmpdir(), "praana-llm-timeout-"));
    const path = join(dir, "praana.config.toml");
    writeFileSync(
      path,
      '[llm]\nconnect_timeout_ms = -5\nstream_idle_timeout_ms = "fast"\n',
      "utf-8",
    );
    getConfigWarnings();
    const cfg = loadConfig(path);
    const warnings = getConfigWarnings();
    expect(warnings.some((w) => w.includes("Invalid llm.connect_timeout_ms"))).toBe(true);
    expect(warnings.some((w) => w.includes("Invalid llm.stream_idle_timeout_ms"))).toBe(true);
    expect(cfg.llm.connect_timeout_ms).toBeUndefined();
    expect(cfg.llm.stream_idle_timeout_ms).toBeUndefined();
  });

  it("rejects a timeout above the setTimeout limit instead of letting it overflow", async () => {
    dir = mkdtempSync(join(tmpdir(), "praana-llm-timeout-"));
    const path = join(dir, "praana.config.toml");
    writeFileSync(
      path,
      "[llm]\nconnect_timeout_ms = 2147483648\nstream_idle_timeout_ms = 2147483647\n",
      "utf-8",
    );
    getConfigWarnings();
    const cfg = loadConfig(path);
    const warnings = getConfigWarnings();
    expect(warnings.some((w) => w.includes("above 2147483647"))).toBe(true);
    expect(cfg.llm.connect_timeout_ms).toBeUndefined();
    expect(cfg.llm.stream_idle_timeout_ms).toBe(2_147_483_647);
  });
});
