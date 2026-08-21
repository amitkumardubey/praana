import { describe, expect, it } from "bun:test";
import {
  agentToLspPosition,
  completionKindFromLsp,
  flattenWorkspaceEdit,
  isApplicableCodeAction,
  mapLocations,
  normalizeHover,
  truncateCompletions,
} from "../src/lsp/map.js";
import { pathToFileUri } from "../src/lsp/types.js";

describe("coords", () => {
  it("converts 1-based agent positions to 0-based LSP", () => {
    expect(agentToLspPosition(1, 1)).toEqual({ line: 0, character: 0 });
    expect(agentToLspPosition(3, 5)).toEqual({ line: 2, character: 4 });
  });
});

describe("normalizeHover", () => {
  it("joins MarkupContent and truncates at 2000", () => {
    const hover = normalizeHover({
      contents: { kind: "markdown", value: "x".repeat(2500) },
    });
    expect(hover?.kind).toBe("markdown");
    expect(hover?.contents.length).toBe(2000);
  });

  it("returns null for empty hover", () => {
    expect(normalizeHover(null)).toBeNull();
    expect(normalizeHover({ contents: "" })).toBeNull();
  });
});

describe("completionKindFromLsp", () => {
  it("maps known kinds and omits unknown", () => {
    expect(completionKindFromLsp(3)).toBe("function");
    expect(completionKindFromLsp(16)).toBe("other");
    expect(completionKindFromLsp(99)).toBeUndefined();
    expect(completionKindFromLsp(undefined)).toBeUndefined();
  });
});

describe("truncateCompletions", () => {
  it("caps at 20 and sets truncated", () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      label: `c${i}`,
      insertText: "NOPE",
      detail: "d".repeat(300),
      kind: 3,
    }));
    const result = truncateCompletions(items);
    expect(result.completions).toHaveLength(20);
    expect(result.truncated).toBe(true);
    expect(result.completions[0]).toEqual({
      label: "c0",
      kind: "function",
      detail: "d".repeat(200),
    });
    expect("insertText" in result.completions[0]!).toBe(false);
  });
});

describe("mapLocations", () => {
  const root = "/proj";
  it("maps LocationLink via targetSelectionRange and drops outside-root URIs", () => {
    const inside = pathToFileUri("/proj/src/a.ts");
    const outside = pathToFileUri("/elsewhere/b.ts");
    const locs = mapLocations(
      [
        {
          targetUri: inside,
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 10, character: 0 },
          },
          targetSelectionRange: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 9 },
          },
        },
        {
          targetUri: outside,
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 0 },
          },
        },
      ],
      root,
    );
    expect(locs).toEqual([
      {
        path: "/proj/src/a.ts",
        startLine: 3,
        startCol: 5,
        endLine: 3,
        endCol: 10,
      },
    ]);
  });
});

describe("flattenWorkspaceEdit", () => {
  it("collects text edits from changes and documentChanges", () => {
    const flat = flattenWorkspaceEdit({
      changes: {
        "file:///proj/a.ts": [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            newText: "A",
          },
        ],
      },
    });
    expect(flat.ok).toBe(true);
    if (flat.ok) expect(flat.files.has("/proj/a.ts")).toBe(true);
  });

  it("rejects create/rename/delete resource ops", () => {
    const flat = flattenWorkspaceEdit({
      documentChanges: [{ kind: "create", uri: "file:///proj/n.ts" }],
    });
    expect(flat.ok).toBe(false);
    if (!flat.ok) expect(flat.reason).toBe("resource_op");
  });
});

describe("isApplicableCodeAction", () => {
  it("keeps edit-bearing and resolvable-data actions; drops command-only", () => {
    expect(
      isApplicableCodeAction(
        { title: "fix", edit: { changes: { "file:///a.ts": [] } } },
        false,
      ),
    ).toBe(true);
    expect(
      isApplicableCodeAction({ title: "fix", data: { x: 1 } }, true),
    ).toBe(true);
    expect(
      isApplicableCodeAction({ title: "fix", command: "do.it" }, true),
    ).toBe(false);
    expect(
      isApplicableCodeAction({ title: "fix", data: { x: 1 } }, false),
    ).toBe(false);
  });
});
