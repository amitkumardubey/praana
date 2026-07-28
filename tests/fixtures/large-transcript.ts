/**
 * Large-session transcript fixture for virtual-transcript benchmarks.
 *
 * Generates `ui_transcript` events representing hundreds of turns with
 * megabyte-scale thinking and tool-result bodies. Tool rows carry
 * `sourceEventId` references to matching `tool_result` events so lazy
 * expansion has something to resolve.
 */
import type { Event, EventActor } from "../../src/types.js";
import type { IndexedTranscriptEntry } from "../../src/ui/tui/transcript/index.js";

export interface LargeFixtureOpts {
  /** Number of complete turn groups to generate. */
  turns?: number;
  /** Characters of thinking text per turn. */
  thinkingChars?: number;
  /** Characters of tool result body per turn. */
  toolChars?: number;
}

function repeatedText(length: number): string {
  const word =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ";
  let out = "";
  while (out.length < length) {
    out += word;
  }
  return out.slice(0, length);
}

function makeEvent(
  event_id: string,
  kind: Event["kind"],
  actor: EventActor,
  payload: Record<string, unknown>,
): Event {
  return {
    event_id,
    session_id: "fixture-session",
    timestamp: Date.now(),
    kind,
    actor,
    payload,
  };
}

export function generateLargeTranscriptEvents(
  opts: LargeFixtureOpts = {},
): Event[] {
  const turns = opts.turns ?? 250;
  const thinkingChars = opts.thinkingChars ?? 5_000;
  const toolChars = opts.toolChars ?? 50_000;
  const events: Event[] = [];

  for (let group = 1; group <= turns; group++) {
    const toolEventId = `tool-result-${group}`;

    events.push(
      makeEvent(`entry-user-${group}`, "ui_transcript", "user", {
        type: "entry",
        entry: {
          id: `user-${group}`,
          role: "user",
          group,
          text: `User prompt for turn ${group}`,
        } satisfies IndexedTranscriptEntry,
      }),
      makeEvent(`entry-thinking-${group}`, "ui_transcript", "agent", {
        type: "entry",
        entry: {
          id: `thinking-${group}`,
          role: "thinking",
          group,
          text: repeatedText(thinkingChars),
          expandable: true,
        } satisfies IndexedTranscriptEntry,
      }),
      makeEvent(`entry-tool-${group}`, "ui_transcript", "agent", {
        type: "entry",
        entry: {
          id: `tool-${group}`,
          role: "tool",
          group,
          toolName: "read_file",
          toolIcon: "◇",
          toolLabel: `read src/file-${group}.ts`,
          toolPending: "running…",
          resultSummary: "ok",
          resultBody: undefined,
          expandable: true,
          sourceEventId: toolEventId,
        } satisfies IndexedTranscriptEntry,
      }),
      makeEvent(`entry-assistant-${group}`, "ui_transcript", "agent", {
        type: "entry",
        entry: {
          id: `assistant-${group}`,
          role: "assistant",
          group,
          text: `Assistant reply for turn ${group}.`,
        } satisfies IndexedTranscriptEntry,
      }),
    );

    events.push(
      makeEvent(toolEventId, "tool_result", "tool", {
        tool: "read_file",
        toolCallId: `tool-${group}`,
        result: {
          ok: true,
          content: repeatedText(toolChars),
        },
      }),
    );
  }

  return events;
}
