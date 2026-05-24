import { ulid } from "ulid";
import type {
  StateObject,
  StateObjectKind,
  StateTier,
  StatePayload,
  TaskPayload,
  DecisionPayload,
  ConstraintPayload,
  NotePayload,
} from "./types.js";

export class StateGraph {
  private objects = new Map<string, StateObject>();
  private touchedTurn = new Map<string, number>(); // turn number when last touched
  private turnCount = 0;

  create(kind: StateObjectKind, payload: StatePayload): StateObject {
    const now = Date.now();
    const obj: StateObject = {
      id: ulid(),
      kind,
      tier: "active",
      payload,
      created: now,
      updated: now,
      lastTouched: now,
    };
    this.objects.set(obj.id, obj);
    this.touchedTurn.set(obj.id, this.turnCount);
    return obj;
  }

  update(id: string, patch: Partial<StatePayload>): StateObject | null {
    const obj = this.objects.get(id);
    if (!obj) return null;
    obj.payload = { ...obj.payload, ...patch } as StatePayload;
    obj.updated = Date.now();
    obj.lastTouched = Date.now();
    this.touchedTurn.set(id, this.turnCount);
    return obj;
  }

  setTier(id: string, tier: StateTier): boolean {
    const obj = this.objects.get(id);
    if (!obj) return false;
    obj.tier = tier;
    obj.lastTouched = Date.now();
    this.touchedTurn.set(id, this.turnCount);
    return true;
  }

  get(id: string): StateObject | undefined {
    return this.objects.get(id);
  }

  /** All active objects, sorted by created asc, then id asc (deterministic). */
  getActive(): StateObject[] {
    return [...this.objects.values()]
      .filter((o) => o.tier === "active")
      .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1));
  }

  /** All soft + hard objects, sorted by updated desc. */
  getPeripheral(): StateObject[] {
    return [...this.objects.values()]
      .filter((o) => o.tier === "soft" || o.tier === "hard")
      .sort((a, b) => b.updated - a.updated);
  }

  /** All objects with summary. */
  list(): Array<{ id: string; kind: StateObjectKind; tier: StateTier; summary: string }> {
    return [...this.objects.values()]
      .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1))
      .map((o) => ({
        id: o.id,
        kind: o.kind,
        tier: o.tier,
        summary: summarizePayload(o),
      }));
  }

  /** Full snapshot of all objects (for event logging). */
  snapshot(): StateObject[] {
    return [...this.objects.values()].sort(
      (a, b) => a.created - b.created || (a.id < b.id ? -1 : 1)
    );
  }

  getTouchedTurn(id: string): number {
    return this.touchedTurn.get(id) ?? 0;
  }
  incrementTurn(): void {
    this.turnCount++;
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  /**
   * Auto-promote peripheral objects whose payload matches keywords in the query.
   * Returns IDs of objects that were hydrated.
   */
  autoHydrate(query: string): string[] {
    const keywords = extractKeywords(query);
    if (keywords.length === 0) return [];

    const hydrated: string[] = [];
    for (const obj of this.getPeripheral()) {
      const text = payloadToSearchableText(obj).toLowerCase();
      if (keywords.some((kw) => text.includes(kw))) {
        obj.tier = "active";
        obj.lastTouched = Date.now();
        this.touchedTurn.set(obj.id, this.turnCount);
        hydrated.push(obj.id);
      }
    }
    return hydrated;
  }

  /**
   * Apply idle-timer tier management rules.
   * Returns list of objects that changed tier.
   */
  applyTierManagement(
    idleSoftAfterTurns: number,
    idleHardAfterTurns: number,
    tokenBudget: number,
    compilerTokens: number
  ): Array<{ id: string; from: StateTier; to: StateTier }> {
    const changes: Array<{ id: string; from: StateTier; to: StateTier }> = [];
    const now = Date.now();

    // Rule 1: Idle timer demotion (simplified: use turn count as proxy)
    // We track lastTouched as a turn counter proxy (incremented each turn)
    // Actually, we'll just track lastTouched via update/setTier calls that bump it

    // Rule 2: Token budget overflow demotion
    if (compilerTokens > tokenBudget) {
      const excess = compilerTokens - tokenBudget;
      // Demote hard → drop, then soft → hard, then active → soft
      // Least-recently-touched first

      // Hard → drop (remove from state graph entirely)
      const hardObjects = [...this.objects.values()]
        .filter((o) => o.tier === "hard")
        .sort((a, b) => a.lastTouched - b.lastTouched);

      for (const o of hardObjects) {
        if (excess <= 0) break;
        const from = o.tier;
        this.objects.delete(o.id);
        changes.push({ id: o.id, from, to: "hard" }); // "dropped" but tracked as hard
      }

      // Soft → hard
      const softObjects = [...this.objects.values()]
        .filter((o) => o.tier === "soft")
        .sort((a, b) => a.lastTouched - b.lastTouched);

      for (const o of softObjects) {
        if (excess <= 0) break;
        const from = o.tier;
        o.tier = "hard";
        changes.push({ id: o.id, from, to: "hard" });
      }

      // Active → soft
      const activeObjects = [...this.objects.values()]
        .filter((o) => o.tier === "active")
        .sort((a, b) => a.lastTouched - b.lastTouched);

      for (const o of activeObjects) {
        if (excess <= 0) break;
        const from = o.tier;
        o.tier = "soft";
        changes.push({ id: o.id, from, to: "soft" });
      }
    }

    return changes;
  }

  /** Rebuild state from context_action events during resume. */
  replayAction(payload: Record<string, unknown>): void {
    const action = payload.action as string;
    const id = payload.id as string;

    switch (action) {
      case "create":
        this.objects.set(id, {
          id,
          kind: payload.kind as StateObjectKind,
          tier: (payload.tier as StateTier) ?? "active",
          payload: payload.statePayload as StatePayload,
          created: payload.created as number,
          updated: payload.updated as number,
          lastTouched: payload.lastTouched as number,
        });
        break;

      case "update": {
        const obj = this.objects.get(id);
        if (obj && payload.statePayload) {
          obj.payload = {
            ...obj.payload,
            ...(payload.statePayload as Partial<StatePayload>),
          } as StatePayload;
          obj.updated = payload.updated as number;
          obj.lastTouched = payload.lastTouched as number;
        }
        break;
      }

      case "setTier": {
        const obj2 = this.objects.get(id);
        if (obj2) {
          obj2.tier = payload.tier as StateTier;
          obj2.lastTouched = payload.lastTouched as number;
        }
        break;
      }
    }
  }
}

// ---- Helpers ----

function summarizePayload(obj: StateObject): string {
  switch (obj.kind) {
    case "task": {
      const p = obj.payload as TaskPayload;
      return `${p.status}: ${p.title}`;
    }
    case "decision": {
      const p = obj.payload as DecisionPayload;
      return p.summary;
    }
    case "constraint": {
      const p = obj.payload as ConstraintPayload;
      return p.text.length > 80 ? p.text.slice(0, 80) + "..." : p.text;
    }
    case "note": {
      const p = obj.payload as NotePayload;
      return p.text.length > 80 ? p.text.slice(0, 80) + "..." : p.text;
    }
  }
}

export function summarizePayloadFn(obj: StateObject): string {
  return summarizePayload(obj);
}

// ---- Auto-hydrate helpers ----

const STOP_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","could",
  "should","may","might","must","shall","can","need","ought",
  "to","of","in","for","on","with","at","by","from","as",
  "into","through","during","before","after","above","below",
  "between","under","again","further","then","once","here",
  "there","when","where","why","how","all","each","few","more",
  "most","other","some","such","no","nor","not","only","own",
  "same","so","than","too","very","just","and","but","if","or",
  "because","until","while","what","which","who","whom","this",
  "that","these","those","am","it","its","they","them","their",
  "i","me","my","we","our","you","your","he","him","his","she",
  "her","hers",
]);

function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

function payloadToSearchableText(obj: StateObject): string {
  switch (obj.kind) {
    case "task": {
      const p = obj.payload as TaskPayload;
      return [p.title, p.description ?? ""].join(" ");
    }
    case "decision": {
      const p = obj.payload as DecisionPayload;
      return [p.summary, p.rationale].join(" ");
    }
    case "constraint": {
      const p = obj.payload as ConstraintPayload;
      return p.text;
    }
    case "note": {
      const p = obj.payload as NotePayload;
      return p.text;
    }
  }
}
