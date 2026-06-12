import type { DecisionPayload, ConstraintPayload, StateObject } from "../types.js";
import type { StateGraph } from "../state-graph.js";
import type { StateSnapshot, TurnDigestDecision } from "./types.js";

export function snapshotStateGraph(stateGraph: StateGraph): StateSnapshot {
  const objects = new Map<string, { kind: string; updated: number; payloadJson: string }>();
  for (const obj of stateGraph.snapshot()) {
    if (obj.retracted) continue;
    objects.set(obj.id, {
      kind: obj.kind,
      updated: obj.updated,
      payloadJson: JSON.stringify(obj.payload),
    });
  }
  return { objects };
}

export function diffStateGraph(
  before: StateSnapshot,
  afterObjects: StateObject[],
): { decisions: TurnDigestDecision[]; constraints: string[] } {
  const decisions: TurnDigestDecision[] = [];
  const constraints: string[] = [];

  for (const obj of afterObjects) {
    if (obj.retracted) continue;
    const prev = before.objects.get(obj.id);

    if (obj.kind === "decision") {
      const payload = obj.payload as DecisionPayload;
      const entry: TurnDigestDecision = {
        summary: payload.summary,
        rationale: payload.rationale || undefined,
      };
      // Omit rationale key entirely if not present — cleaner serialisation
      if (!entry.rationale) delete (entry as Partial<TurnDigestDecision>).rationale;
      if (!prev) {
        decisions.push(entry);
        continue;
      }
      if (obj.updated > prev.updated || prev.payloadJson !== JSON.stringify(obj.payload)) {
        decisions.push(entry);
      }
    }

    if (obj.kind === "constraint") {
      const text = (obj.payload as ConstraintPayload).text;
      if (!prev) {
        constraints.push(text);
        continue;
      }
      if (obj.updated > prev.updated || prev.payloadJson !== JSON.stringify(obj.payload)) {
        constraints.push(text);
      }
    }
  }

  return { decisions, constraints };
}
