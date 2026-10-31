// ============================================================
// PRAANA — High-Performance Zero-Dependency SSE Parser
// ============================================================

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

/**
 * Parses a byte/string stream of Server-Sent Events (SSE) into discrete events.
 *
 * Event fields may span any number of chunks. Line endings are CRLF, CR, or LF.
 * A trailing CR is held back so a CRLF split across chunks is not read as a
 * bare CR plus an extra blank line. A blank line dispatches the event. At
 * end of stream, a final event with no terminating blank line is dispatched
 * once.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let current: { event?: string; data?: string; id?: string } = {};
  let hasData = false;

  const reset = (): void => {
    current = {};
    hasData = false;
  };

  const dispatch = (): SseEvent | null => {
    if (!hasData || current.data === undefined) {
      reset();
      return null;
    }
    const ev: SseEvent = { data: current.data };
    if (current.event !== undefined) ev.event = current.event;
    if (current.id !== undefined) ev.id = current.id;
    reset();
    return ev;
  };

  const applyLine = function* (line: string): Generator<SseEvent, void, unknown> {
    if (line === "") {
      const ev = dispatch();
      if (ev) yield ev;
      return;
    }
    if (line.startsWith(":")) return;

    const colonIdx = line.indexOf(":");
    let field: string;
    let val: string;
    if (colonIdx === -1) {
      field = line;
      val = "";
    } else {
      field = line.slice(0, colonIdx);
      val = line[colonIdx + 1] === " " ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1);
    }

    if (field === "data") {
      current.data = current.data !== undefined ? `${current.data}\n${val}` : val;
      hasData = true;
    } else if (field === "event") {
      current.event = val;
    } else if (field === "id") {
      current.id = val;
    }
  };

  /**
   * Pull complete lines out of `buffer`. When this is not the end of the
   * stream and the buffer ends in CR, that CR stays buffered: the next byte
   * may be LF and the pair is one CRLF ending.
   */
  const takeLines = (eof: boolean): string[] => {
    let heldCr = false;
    if (!eof && buffer.endsWith("\r")) {
      buffer = buffer.slice(0, -1);
      heldCr = true;
    }
    const parts = buffer.split(/\r\n|\r|\n/);
    const incomplete = parts.pop() ?? "";
    buffer = heldCr ? `${incomplete}\r` : incomplete;
    if (eof && buffer !== "") {
      parts.push(buffer);
      buffer = "";
    }
    return parts;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of takeLines(false)) {
        yield* applyLine(line);
      }
    }

    buffer += decoder.decode();
    for (const line of takeLines(true)) {
      yield* applyLine(line);
    }
    const tail = dispatch();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
