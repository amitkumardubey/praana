import type { Event } from "./types.js";
import type { Session } from "./session.js";
import type { SessionEvent } from "./session-outcome.js";
import { computeContextPressureRatio } from "./context-pressure.js";

export interface ClassicCompactionResult {
  compacted: boolean;
  eventsCompacted: number;
  factsStored: number;
  pressureRatio: number;
}

export function eventsToSessionEvents(events: Event[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const ev of events) {
    switch (ev.kind) {
      case "user_message":
        out.push({
          type: "user_message",
          timestamp: ev.timestamp,
          content: String(ev.payload.text ?? ""),
        });
        break;
      case "agent_message":
        out.push({
          type: "agent_message",
          timestamp: ev.timestamp,
          content: String(ev.payload.text ?? ""),
        });
        break;
      case "tool_call":
        out.push({
          type: "tool_use",
          timestamp: ev.timestamp,
          tool_name: String(ev.payload.tool ?? "unknown"),
          args: (ev.payload.args as Record<string, unknown>) ?? {},
        });
        break;
      case "tool_result":
        out.push({
          type: "tool_result",
          timestamp: ev.timestamp,
          tool_name: String(ev.payload.tool ?? "unknown"),
          result: ev.payload.result,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Classic-mode compaction is retired until the compiler cutover: this stub never
 * compacts, writes no memories, and hides no history. `compiler.auto_compact_at`
 * and `compiler.compact_chunk_fraction` have no effect in classic mode. Retain
 * this compatibility result API. */
export async function maybeAutoCompactClassic(
  session: Session,
  promptTokens: number,
  modelId: string,
): Promise<ClassicCompactionResult> {
  const pressureRatio = computeContextPressureRatio(
    promptTokens,
    session.getContextWindowTokens(modelId),
    session.config.compiler.reserved_output_tokens ?? 0,
  );
  return { compacted: false, eventsCompacted: 0, factsStored: 0, pressureRatio };
}

export function formatCompactionBanner(result: ClassicCompactionResult): string | null {
  if (!result.compacted) return null;
  return (
    `Auto-compacted ${result.eventsCompacted} older turn(s) into ` +
    `${result.factsStored} memory fact(s) (${(result.pressureRatio * 100).toFixed(0)}% context)`
  );
}
