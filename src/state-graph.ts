import { ulid } from "ulid";
import { bm25Relevance } from "./context-engine/bm25.js";
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

  clear(): void {
    this.objects.clear();
    this.touchedTurn.clear();
    this.turnCount = 0;
  }

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

  retractObject(id: string): boolean {
    const obj = this.objects.get(id);
    if (!obj) return false;
    obj.retracted = true;
    obj.updated = Date.now();
    obj.lastTouched = Date.now();
    this.touchedTurn.set(id, this.turnCount);
    return true;
  }

  get(id: string): StateObject | undefined {
    return this.objects.get(id);
  }

  /** All active objects; focused object first, then by created asc, id asc. */
  getActive(): StateObject[] {
    return [...this.objects.values()]
      .filter((o) => o.tier === "active" && !o.retracted)
      .sort((a, b) => {
        const af = a.focused ? 1 : 0;
        const bf = b.focused ? 1 : 0;
        if (bf !== af) return bf - af;
        return a.created - b.created || (a.id < b.id ? -1 : 1);
      });
  }

  /** Pin one task/object as focused; clears focus on all others. */
  setFocus(id: string): boolean {
    const target = this.objects.get(id);
    if (!target) return false;
    for (const obj of this.objects.values()) {
      obj.focused = obj.id === id;
    }
    target.lastTouched = Date.now();
    this.touchedTurn.set(id, this.turnCount);
    return true;
  }

  /** All soft + hard objects, sorted by updated desc. */
  getPeripheral(): StateObject[] {
    return [...this.objects.values()]
      .filter((o) => (o.tier === "soft" || o.tier === "hard") && !o.retracted)
      .sort((a, b) => b.updated - a.updated);
  }

  /** All objects with summary. */
  list(): Array<{ id: string; kind: StateObjectKind; tier: StateTier; summary: string }> {
    return [...this.objects.values()]
      .filter((o) => !o.retracted)
      .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1))
      .map((o) => ({
        id: o.id,
        kind: o.kind,
        tier: o.tier,
        summary: summarizePayload(o),
      }));
  }

  /** Full snapshot including retracted objects — for event logging and audit. */
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
   * Promote peripheral objects whose payload matches the query.
   * Two passes: (1) substring keyword match, (2) BM25 relevance above threshold.
   * Returns AutoHydrateResult[] — callers use .text for downstream scoring boost.
   */
  autoHydrate(query: string): AutoHydrateResult[] {
    const keywords = extractKeywords(query);
    const hydrated: AutoHydrateResult[] = [];
    const hydratedIds = new Set<string>();

    // Pass 1: substring keyword match (fast, low overhead)
    if (keywords.length > 0) {
      for (const obj of this.getPeripheral()) {
        const text = payloadToSearchableText(obj);
        if (keywords.some((kw) => text.toLowerCase().includes(kw))) {
          obj.tier = "active";
          obj.lastTouched = Date.now();
          this.touchedTurn.set(obj.id, this.turnCount);
          hydrated.push({ id: obj.id, text, method: "substring" });
          hydratedIds.add(obj.id);
        }
      }
    }

    // Pass 2: BM25 — catches semantic overlap that substring misses
    for (const obj of this.getPeripheral()) {
      if (hydratedIds.has(obj.id)) continue;
      const text = payloadToSearchableText(obj);
      const score = bm25Relevance(query, text);
      if (score >= BM25_HYDRATE_THRESHOLD) {
        obj.tier = "active";
        obj.lastTouched = Date.now();
        this.touchedTurn.set(obj.id, this.turnCount);
        hydrated.push({ id: obj.id, text, method: "bm25" });
        hydratedIds.add(obj.id);
      }
    }

    return hydrated;
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

      case "setFocus": {
        const obj3 = this.objects.get(id);
        if (obj3) {
          for (const o of this.objects.values()) {
            o.focused = o.id === id;
          }
          obj3.lastTouched = payload.lastTouched as number;
        }
        break;
      }

      case "retract": {
        const obj4 = this.objects.get(id);
        if (obj4) {
          obj4.retracted = true;
          obj4.updated = payload.updated as number;
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

/** Minimum BM25 score for a peripheral object to be promoted via BM25 hydration. */
const BM25_HYDRATE_THRESHOLD = 0.15;

/** Result from autoHydrate — includes the object’s text for downstream scoring boost. */
export interface AutoHydrateResult {
  id: string;
  /** Searchable payload text; passed to scoring for hydrate_boost calculation. */
  text: string;
  /** Which signal triggered hydration. */
  method: "substring" | "bm25";
}

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
