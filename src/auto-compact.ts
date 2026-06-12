import type { Event } from "./types.js";
import type { Session } from "./session.js";
import type { SessionEvent } from "./memory/types.js";
import {
  computeContextPressureRatio,
  resolveCompactionConfig,
  shouldTriggerAutoCompact,
} from "./context-pressure.js";
import { getAppLogger } from "./logger.js";

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

function selectableHistoryEvents(events: Event[]): Event[] {
  return events.filter(
    (e) => e.kind !== "context_action" && e.kind !== "system_note",
  );
}

/**
 * Classic-mode compaction: summarise oldest transcript events into Cognitive Memory
 * and mark them compressed so they leave the compiled prompt.
 */
export async function maybeAutoCompactClassic(
  session: Session,
  promptTokens: number,
  modelId: string,
): Promise<ClassicCompactionResult> {
  const reserved = session.config.compiler.reserved_output_tokens ?? 0;
  const contextWindow = session.getContextWindowTokens(modelId);
  const pressureRatio = computeContextPressureRatio(
    promptTokens,
    contextWindow,
    reserved,
  );

  const { trigger, armed } = shouldTriggerAutoCompact(
    pressureRatio,
    session.config.compiler,
    session.isCompactionArmed(),
  );
  session.setCompactionArmed(armed);

  if (!trigger) {
    return { compacted: false, eventsCompacted: 0, factsStored: 0, pressureRatio };
  }

  if (!session.memoryEnabled || !session.memoryStore) {
    return { compacted: false, eventsCompacted: 0, factsStored: 0, pressureRatio };
  }

  const { compactChunkFraction } = resolveCompactionConfig(session.config.compiler);
  const all = session.eventLog.readAllUncompressed();
  const filtered = selectableHistoryEvents(all);
  if (filtered.length < 4) {
    return { compacted: false, eventsCompacted: 0, factsStored: 0, pressureRatio };
  }

  const chunkSize = Math.max(2, Math.floor(filtered.length * compactChunkFraction));
  const toCompress = filtered.slice(0, chunkSize);
  if (toCompress.length === 0) {
    return { compacted: false, eventsCompacted: 0, factsStored: 0, pressureRatio };
  }

  const sessionEvents = eventsToSessionEvents(toCompress);
  const factsStored = await session.memoryStore.compressTurns(sessionEvents);
  session.eventLog.markEventsAsCompressed(toCompress.map((e) => e.event_id));

  session.eventLog.append({
    kind: "system_note",
    actor: "kernel",
    payload: {
      type: "history_compacted",
      eventsCompacted: toCompress.length,
      factsStored,
      pressureRatio: Number(pressureRatio.toFixed(3)),
    },
  });

  if (session.debug) {
    getAppLogger().child("session").debug(
      `${toCompress.length} event(s) → ${factsStored} memory fact(s) (pressure ${(pressureRatio * 100).toFixed(0)}%)`,
      { details: { events: toCompress.length, factsStored, pressureRatio } },
    );
  }

  return {
    compacted: true,
    eventsCompacted: toCompress.length,
    factsStored,
    pressureRatio,
  };
}

export function formatCompactionBanner(result: ClassicCompactionResult): string | null {
  if (!result.compacted) return null;
  return (
    `Auto-compacted ${result.eventsCompacted} older turn(s) into ` +
    `${result.factsStored} memory fact(s) (${(result.pressureRatio * 100).toFixed(0)}% context)`
  );
}
