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
 * Correctly handles multibyte UTF-8 splits, partial line buffers, and CRLF/LF line breaks.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\r|\n/);
      // The last element is the incomplete remainder line
      buffer = lines.pop() ?? "";

      let currentEvent: Partial<SseEvent> = {};
      let hasData = false;

      for (const line of lines) {
        if (line.trim() === "") {
          // Empty line indicates event boundary
          if (hasData && currentEvent.data !== undefined) {
            yield {
              event: currentEvent.event,
              data: currentEvent.data,
              id: currentEvent.id,
            };
          }
          currentEvent = {};
          hasData = false;
          continue;
        }

        if (line.startsWith(":")) {
          // SSE comment, ignore
          continue;
        }

        const colonIdx = line.indexOf(":");
        let field: string;
        let val: string;

        if (colonIdx === -1) {
          field = line;
          val = "";
        } else {
          field = line.slice(0, colonIdx);
          // Standard SSE: if space follows colon, strip single leading space
          val = line[colonIdx + 1] === " " ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1);
        }

        if (field === "data") {
          currentEvent.data = currentEvent.data !== undefined ? `${currentEvent.data}\n${val}` : val;
          hasData = true;
        } else if (field === "event") {
          currentEvent.event = val;
        } else if (field === "id") {
          currentEvent.id = val;
        }
      }

      // If there's an unclosed event at end of chunk without trailing newline, handle on boundary
      if (hasData && currentEvent.data !== undefined && buffer === "") {
        yield {
          event: currentEvent.event,
          data: currentEvent.data,
          id: currentEvent.id,
        };
      }
    }

    // Flush any remaining line
    if (buffer.trim() !== "") {
      const line = buffer;
      if (line.startsWith("data:")) {
        const val = line.slice(5).trimStart();
        yield { data: val };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
