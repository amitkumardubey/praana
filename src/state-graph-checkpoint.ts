import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Event } from "./types.js";
import type { StateGraph } from "./state-graph.js";
import type { StateGraphCheckpoint } from "./state-graph.js";

export const STATE_GRAPH_CHECKPOINT_FILENAME = "state_graph_checkpoint.json";
const STATE_GRAPH_CHECKPOINT_TMP = "state_graph_checkpoint.json.tmp";

export function getStateGraphCheckpointPath(sessionDir: string): string {
  return join(sessionDir, STATE_GRAPH_CHECKPOINT_FILENAME);
}

export function loadStateGraphCheckpoint(
  sessionDir: string,
): StateGraphCheckpoint | null {
  const path = getStateGraphCheckpointPath(sessionDir);
  if (!existsSync(path)) return null;

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as StateGraphCheckpoint;
    if (
      raw.version !== 1 ||
      typeof raw.last_event_id !== "string" ||
      !Array.isArray(raw.objects) ||
      typeof raw.touched_turn !== "object" ||
      raw.touched_turn === null ||
      typeof raw.session_turn_count !== "number" ||
      typeof raw.state_graph_turn_count !== "number"
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

export function saveStateGraphCheckpoint(
  sessionDir: string,
  data: StateGraphCheckpoint,
): void {
  const path = getStateGraphCheckpointPath(sessionDir);
  const tmpPath = join(sessionDir, STATE_GRAPH_CHECKPOINT_TMP);
  writeFileSync(tmpPath, JSON.stringify(data) + "\n", "utf-8");
  renameSync(tmpPath, path);
}

export function deleteStateGraphCheckpoint(sessionDir: string): void {
  const path = getStateGraphCheckpointPath(sessionDir);
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

/** Index of the first event strictly after lastEventId, or 0 if not found. */
export function findReplayStartIndex(
  events: Event[],
  lastEventId: string,
): number | null {
  const idx = events.findIndex((ev) => ev.event_id === lastEventId);
  if (idx === -1) return null;
  return idx + 1;
}

export function replayStateGraphFromEvents(
  stateGraph: StateGraph,
  events: Event[],
  startIndex: number,
): number {
  let replayed = 0;
  for (let i = startIndex; i < events.length; i++) {
    const ev = events[i];
    if (ev.kind === "context_action") {
      stateGraph.replayAction(ev.payload);
      replayed++;
    } else if (
      ev.kind === "system_note" &&
      ev.payload.type === "state_reset" &&
      ev.payload.cleared === "all"
    ) {
      stateGraph.clear();
      replayed++;
    }
  }
  return replayed;
}
