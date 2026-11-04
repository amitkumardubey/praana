import { describe, expect, it } from "bun:test";
import { parseAwsEventStream } from "../src/llm/aws-sigv4.js";

function frame(eventType: string, payload: unknown, messageType?: string): Uint8Array {
  function header(name: string, value: string): Buffer {
    const n = Buffer.from(name), v = Buffer.from(value);
    const result = Buffer.alloc(1 + n.length + 1 + 2 + v.length);
    result.writeUInt8(n.length, 0);
    n.copy(result, 1);
    result.writeUInt8(7, 1 + n.length);
    result.writeUInt16BE(v.length, 2 + n.length);
    v.copy(result, 4 + n.length);
    return result;
  }
  const headers = Buffer.concat([header(":event-type", eventType), ...(messageType ? [header(":message-type", messageType)] : [])]);
  const body = Buffer.from(JSON.stringify(payload));
  const result = Buffer.alloc(16 + headers.length + body.length);
  result.writeUInt32BE(result.length, 0);
  result.writeUInt32BE(headers.length, 4);
  headers.copy(result, 12);
  body.copy(result, 12 + headers.length);
  return result;
}

async function decode(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const result: Record<string, unknown>[] = [];
  for await (const item of parseAwsEventStream(stream)) result.push(item);
  return result;
}

describe("AWS event type headers", () => {
  it("wraps a bare event payload", async () => {
    expect(await decode(frame("messageStop", { stopReason: "end_turn" }, "event"))).toEqual([
      { messageStop: { stopReason: "end_turn" }, ":message-type": "event" },
    ]);
  });
  it("does not wrap an already wrapped event payload", async () => {
    expect(await decode(frame("messageStop", { messageStop: { stopReason: "end_turn" } }))).toEqual([
      { messageStop: { stopReason: "end_turn" } },
    ]);
  });
});
