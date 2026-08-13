/**
 * LSP Content-Length framing helpers (pure).
 */

import type { JsonRpcMessage } from "./types.js";

export function encodeMessage(body: object): Buffer {
  const json = Buffer.from(JSON.stringify(body), "utf8");
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, "utf8");
  return Buffer.concat([header, json]);
}

/**
 * Incremental parser for LSP Content-Length framed messages.
 */
export class FrameParser {
  private buffer = Buffer.alloc(0);

  append(chunk: Buffer): JsonRpcMessage[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: JsonRpcMessage[] = [];

    while (true) {
      const headerEnd = indexOfHeaderEnd(this.buffer);
      if (headerEnd < 0) break;

      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Skip a leading CRLF or advance one byte to resync
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (!Number.isFinite(length) || length < 0) {
        throw new Error(`Invalid Content-Length: ${match[1]}`);
      }

      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) break;

      const bodyBuf = this.buffer.subarray(bodyStart, bodyEnd);
      this.buffer = this.buffer.subarray(bodyEnd);

      const text = bodyBuf.toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        throw new Error(
          `Malformed JSON-RPC body: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!parsed || typeof parsed !== "object") {
        throw new Error("JSON-RPC message must be an object");
      }
      out.push(parsed as JsonRpcMessage);
    }

    return out;
  }
}

function indexOfHeaderEnd(buf: Buffer): number {
  const crlf = Buffer.from("\r\n\r\n");
  return buf.indexOf(crlf);
}
