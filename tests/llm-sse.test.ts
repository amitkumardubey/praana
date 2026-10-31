import { describe, expect, it } from "bun:test";
import { parseSseStream, type SseEvent } from "../src/llm/sse.js";

/**
 * Mixed fixture: comments, id, multi-line data, CRLF, bare CR, and [DONE].
 * One-chunk parsing of this bytestring is the reference; every split must match.
 */
const FIXTURE = [
  ": keep-alive\r\n",
  "id: 42\r\n",
  "event: message\r\n",
  "data: hello\r\n",
  "data: world\r\n",
  "\r\n",
  "event: ping\r",
  "data: pong\r",
  "\r",
  "data: [DONE]\n",
  "\n",
].join("");

const EXPECTED: Array<{ event: string | null; data: string; id: string | null }> = [
  { event: "message", data: "hello\nworld", id: "42" },
  { event: "ping", data: "pong", id: null },
  { event: null, data: "[DONE]", id: null },
];

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function visible(ev: SseEvent): { event: string | null; data: string; id: string | null } {
  return {
    event: ev.event ?? null,
    data: ev.data,
    id: ev.id ?? null,
  };
}

async function collect(
  chunks: Uint8Array[],
): Promise<Array<{ event: string | null; data: string; id: string | null }>> {
  const out: Array<{ event: string | null; data: string; id: string | null }> = [];
  for await (const ev of parseSseStream(streamFrom(chunks))) {
    out.push(visible(ev));
  }
  return out;
}

/** Deterministic PRNG so 3-way splits are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("parseSseStream", () => {
  it("parses one chunk and every byte split of a mixed fixture the same way", async () => {
    const bytes = encode(FIXTURE);
    const oneChunk = await collect([bytes]);
    expect(oneChunk).toEqual(EXPECTED);

    const failures: string[] = [];
    for (let offset = 0; offset <= bytes.length; offset++) {
      const got = await collect([bytes.slice(0, offset), bytes.slice(offset)]);
      if (JSON.stringify(got) !== JSON.stringify(EXPECTED)) {
        failures.push(`offset ${offset}: ${JSON.stringify(got)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("parses random 3-way splits of the mixed fixture the same way", async () => {
    const bytes = encode(FIXTURE);
    const rand = mulberry32(0x5eed_2026);
    const failures: string[] = [];
    for (let n = 0; n < 40; n++) {
      const a = Math.floor(rand() * (bytes.length + 1));
      const b = Math.floor(rand() * (bytes.length + 1));
      const i = Math.min(a, b);
      const j = Math.max(a, b);
      const got = await collect([
        bytes.slice(0, i),
        bytes.slice(i, j),
        bytes.slice(j),
      ]);
      if (JSON.stringify(got) !== JSON.stringify(EXPECTED)) {
        failures.push(`splits ${i},${j}: ${JSON.stringify(got)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("dispatches a final event that has no trailing blank line", async () => {
    const got = await collect([encode("event: message\ndata: hello")]);
    expect(got).toEqual([{ event: "message", data: "hello", id: null }]);
  });

  it("rejoins a UTF-8 character split across chunks", async () => {
    const bytes = encode("data: café\n\n");
    const splitAt = bytes.indexOf(0xc3);
    expect(splitAt).toBeGreaterThan(0);
    expect(bytes[splitAt + 1]).toBe(0xa9);
    const got = await collect([bytes.slice(0, splitAt + 1), bytes.slice(splitAt + 1)]);
    expect(got).toEqual([{ event: null, data: "café", id: null }]);
  });

  it("passes [DONE] through as event data", async () => {
    const got = await collect([encode("data: [DONE]\n\n")]);
    expect(got).toEqual([{ event: null, data: "[DONE]", id: null }]);
  });
});
