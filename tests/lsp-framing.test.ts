import { describe, expect, it } from "bun:test";
import { encodeMessage, FrameParser } from "../src/lsp/framing.js";

describe("LSP framing", () => {
  it("encodes Content-Length header and body", () => {
    const buf = encodeMessage({ jsonrpc: "2.0", method: "initialized" });
    const text = buf.toString("utf8");
    expect(text.startsWith("Content-Length: ")).toBe(true);
    expect(text.includes("\r\n\r\n")).toBe(true);
    expect(text).toContain('"method":"initialized"');
  });

  it("parses a single framed message", () => {
    const parser = new FrameParser();
    const msgs = parser.append(
      encodeMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id: 1, result: { ok: true } });
  });

  it("parses messages split across chunks", () => {
    const full = encodeMessage({ jsonrpc: "2.0", id: 2, result: 42 });
    const parser = new FrameParser();
    expect(parser.append(full.subarray(0, 8))).toEqual([]);
    expect(parser.append(full.subarray(8, 20))).toEqual([]);
    const msgs = parser.append(full.subarray(20));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id: 2, result: 42 });
  });

  it("parses multiple messages in one chunk", () => {
    const a = encodeMessage({ jsonrpc: "2.0", id: 1, result: "a" });
    const b = encodeMessage({ jsonrpc: "2.0", id: 2, result: "b" });
    const parser = new FrameParser();
    const msgs = parser.append(Buffer.concat([a, b]));
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ id: 1 });
    expect(msgs[1]).toMatchObject({ id: 2 });
  });
});
