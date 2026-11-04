import { afterEach, describe, expect, it } from "bun:test";
import { GoogleDriver } from "../src/llm/drivers/google.js";
import { parseSseStream } from "../src/llm/sse.js";
import { createTestLogger, getAppLogger, setAppLogger, type PraanaLogger } from "../src/logger.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "../src/llm/types.js";

/**
 * A normally terminated Google stream must store function-call arguments as
 * an object. An unparseable string payload uses the repaired object or the
 * `{ _raw, _parseError }` wrapper, not the raw string.
 */

const originalFetch = globalThis.fetch;
const originalRandom = Math.random;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
});

function sse(frames: unknown[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
}

async function collect(body: string): Promise<StreamEvent[]> {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const req: StreamRequest = {
    model: "m",
    provider: "google",
    messages: [{ role: "user", content: "hi" }],
    strictStreamEnd: true,
  };
  const auth: ResolvedAuth = { apiKey: "test-key" };
  const events: StreamEvent[] = [];
  for await (const event of new GoogleDriver().stream(req, auth)) events.push(event);
  return events;
}

describe("Google string arguments on a finished stream", () => {
  it("stores unparseable string args as an object", async () => {
    Math.random = () => 0.123456789;
    const events = await collect(sse([{
      candidates: [{
        content: {
          parts: [{ functionCall: { name: "read_file", args: "not json" } }],
        },
        finishReason: "STOP",
      }],
    }]));
    const ended = events.find((event) => event.type === "tool_call_end");
    expect(ended?.type).toBe("tool_call_end");
    if (ended?.type !== "tool_call_end") return;
    expect(typeof ended.toolCall.args).toBe("object");
    expect(ended.toolCall.args).toEqual({ _raw: "not json", _parseError: true });
    expect(events.at(-1)).toMatchObject({ type: "done", reason: "tool_use" });
  });
});

describe("discarded SSE tail", () => {
  let previousLogger: PraanaLogger | undefined;
  const lines: string[] = [];

  afterEach(() => {
    if (previousLogger) setAppLogger(previousLogger);
    previousLogger = undefined;
    lines.length = 0;
  });

  function installLogger(): void {
    lines.length = 0;
    previousLogger = getAppLogger();
    setAppLogger(createTestLogger((line) => lines.push(line)));
  }

  async function read(chunks: string[]): Promise<string[]> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const event of parseSseStream(stream)) out.push(event.data);
    return out;
  }

  it("logs a discarded partial line once, with the byte count and not the text", async () => {
    installLogger();
    const tail = 'data: {"secret":"hunter2"';
    const data = await read([`data: {"ok":true}\n\n${tail}`]);
    expect(data).toEqual(['{"ok":true}']);
    const warnings = lines.filter((line) => line.includes("partial SSE line"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`"bytes":${Buffer.byteLength(tail)}`);
    expect(warnings.join("\n")).not.toContain("hunter2");
    expect(warnings.join("\n")).not.toContain("secret");
  });

  it("does not log when every line is terminated", async () => {
    installLogger();
    const data = await read(['data: {"ok":true}\n\n']);
    expect(data).toEqual(['{"ok":true}']);
    expect(lines.some((line) => line.includes("partial SSE line"))).toBe(false);
  });
});
