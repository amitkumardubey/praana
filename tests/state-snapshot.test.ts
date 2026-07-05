import { describe, it, expect } from "bun:test";
import { diffStateGraph, snapshotStateGraph } from "../src/context-engine/state-snapshot.js";
import { StateGraph } from "../src/state-graph.js";
import type { StateSnapshot } from "../src/context-engine/types.js";

describe("snapshotStateGraph", () => {
  it("skips retracted objects", () => {
    const graph = new StateGraph();
    const obj = graph.create("decision", { summary: "use sqlite", rationale: "simple" });
    graph.retractObject(obj.id);

    const snapshot = snapshotStateGraph(graph);
    expect(snapshot.objects.size).toBe(0);
  });
});

describe("diffStateGraph", () => {
  it("detects newly added decisions and constraints", () => {
    const graph = new StateGraph();
    graph.create("decision", { summary: "use sqlite", rationale: "simple" });
    graph.create("constraint", { text: "never store plaintext passwords" });

    const empty: StateSnapshot = { objects: new Map() };
    const diff = diffStateGraph(empty, graph.snapshot());

    expect(diff.decisions).toEqual([{ summary: "use sqlite", rationale: "simple" }]);
    expect(diff.constraints).toEqual(["never store plaintext passwords"]);
    expect(diff.retractedDecisions).toEqual([]);
    expect(diff.retractedConstraints).toEqual([]);
  });

  it("detects retracted decisions and constraints", () => {
    const before = new StateGraph();
    before.create("decision", { summary: "use sqlite", rationale: "simple" });
    before.create("constraint", { text: "use bun" });

    const after = new StateGraph();
    after.create("constraint", { text: "never store plaintext passwords" });

    const diff = diffStateGraph(snapshotStateGraph(before), after.snapshot());

    expect(diff.decisions).toEqual([]);
    expect(diff.constraints).toEqual(["never store plaintext passwords"]);
    expect(diff.retractedDecisions).toEqual(["use sqlite"]);
    expect(diff.retractedConstraints).toEqual(["use bun"]);
  });

  it("treats a missing previous object as a retraction", () => {
    const before: StateSnapshot = {
      objects: new Map([
        [
          "old-decision",
          {
            kind: "decision",
            updated: 1,
            payloadJson: JSON.stringify({ summary: "old way", rationale: "" }),
          },
        ],
      ]),
    };

    const after = new StateGraph();
    const diff = diffStateGraph(before, after.snapshot());

    expect(diff.retractedDecisions).toEqual(["old way"]);
  });
});
