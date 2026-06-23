import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Event } from "./types.js";
import type { StateGraph } from "./state-graph.js";

export interface StateGraphCheckpoint {
  version: 1;
  saved_at: number;
  last_event_id: string;
  /**
   * Absolute session turn count at checkpoint time. Restored to Session.turnCount.
   * Tracks the session's age across /clear resets.
   */
  session_turn_count: number;
  /**
   * StateGraph-internal turn counter. Resets to 0 after /clear, so may differ
   * from session_turn_count when a clear has occurred in the current epoch.
   * Used by applyTierManagement() for idle-turn delta calculations.
   */
  state_graph_turn_count: number;
  objects: StateObject[];
  touched_turn: Record<string, number>;
}

import type { StateObject } from "./types.js";

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
  // Write + fsync the tmp file before renaming so the kernel flush is guaranteed.
  // Without fsync, a crash between writeSync and rename can atomically install a
  // buffered (potentially empty/partial) file. Same pattern as events.jsonl.
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, JSON.stringify(data) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
