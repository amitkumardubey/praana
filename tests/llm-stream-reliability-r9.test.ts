import { afterEach, describe, expect, it } from "bun:test";
import { GoogleDriver } from "../src/llm/drivers/google.js";
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
