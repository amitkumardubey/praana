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
 * A trailing CR is a line ending. `skipNextLf` drops a following LF so a
 * CRLF split across chunks is one break, and a CR-CR blank line is
 * dispatched without waiting for more bytes. A blank line dispatches the
 * event. At end of stream, an event is dispatched only when every line was
 * newline-terminated and the blank line is all that is missing. A partial
 * final line is never dispatched, and it withholds that event.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let current: { event?: string; data?: string; id?: string } = {};
  let hasData = false;
  let skipNextLf = false;

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
   * Pull complete lines out of `buffer`. A trailing CR is a line ending and
   * arms `skipNextLf` so the next LF is not a second break. A partial line
   * stays in `buffer` and is never returned, including at EOF.
   */
  const takeLines = (eof: boolean): string[] => {
    if (skipNextLf) {
      if (buffer.startsWith("\n")) {
        buffer = buffer.slice(1);
        skipNextLf = false;
      } else if (buffer.length > 0 || eof) {
        skipNextLf = false;
      }
    }
    const trailingCr = !eof && buffer.endsWith("\r");
    const parts = buffer.split(/\r\n|\r|\n/);
    const incomplete = parts.pop() ?? "";
    buffer = incomplete;
    if (trailingCr) skipNextLf = true;
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
    // A leftover here is a partial line. Do not dispatch the event it belongs to.
    if (buffer === "") {
      const tail = dispatch();
      if (tail) yield tail;
    }
  } finally {
    reader.releaseLock();
  }
}
