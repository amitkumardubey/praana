import { describe, expect, test } from "bun:test";
import {
  buildCrossSessionMemory,
  buildNativeStatusSection,
  buildSnapshot,
  trimToStrictTokenBudget,
  type SnapshotInput,
} from "../src/prompt/snapshot.js";
import { trimSectionToTokenBudget } from "../src/prompt/frame.js";
import { estimateTokens } from "../src/token-estimate.js";

const base: SnapshotInput = {
  date: "2026-11-19",
  timeZone: "UTC",
  cwd: "/work/project",
  sessionId: "sess-1",
  skills: [
    { name: "zeta", description: "Last alphabetically, first here." },
    { name: "alpha", description: "Second." },
  ],
  skillsTokenBudget: 500,
  memoryIndex: "- [note](note.md): a remembered fact",
  memoryRecallEnabled: true,
  memoryTokenBudget: 500,
  workflowSection: "## Workflow Context\n\n- Typical lean sequence: read_file → edit_file",
};

describe("buildSnapshot", () => {
  test("renders every section in order from explicit inputs", () => {
    const text = buildSnapshot({ ...base, nativeStatus: { kind: "disabled" } });
    const order = [
      "# Session Snapshot",
      "Current date: 2026-11-19 (UTC)",
      "Working directory: /work/project",
      "Session ID: sess-1",
      "## Native Addon",
      "## Available Skills",
      "# Cross-Session Memory",
      "## Workflow Context",
    ].map((marker) => text.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("keeps skills in the given order", () => {
    const text = buildSnapshot(base);
    expect(text.indexOf("**zeta**")).toBeLessThan(text.indexOf("**alpha**"));
  });

  test("is deterministic and does not read the clock or mutate input", () => {
    const before = structuredClone(base);
    const first = buildSnapshot(base);
    const realNow = Date.now;
    Date.now = () => 0;
    try {
      expect(buildSnapshot({ ...base })).toBe(first);
    } finally {
      Date.now = realNow;
    }
    expect(base).toEqual(before);
  });

  test("omits empty sections instead of emitting empty ones", () => {
    const text = buildSnapshot({
      date: "2026-11-19",
      cwd: "/w",
      sessionId: "s",
      skills: [],
      skillsTokenBudget: 100,
      memoryIndex: "  \n",
      memoryTokenBudget: 100,
      workflowSection: "   ",
      nativeStatus: { kind: "available" } as never,
    });
    expect(text).toBe("# Session Snapshot\n\nCurrent date: 2026-11-19\nWorking directory: /w\nSession ID: s");
  });

  test("zero and negative budgets emit nothing for that section", () => {
    for (const budget of [0, -5]) {
      const text = buildSnapshot({ ...base, skillsTokenBudget: budget, memoryTokenBudget: budget });
      expect(text).not.toContain("## Available Skills");
      expect(text).not.toContain("# Cross-Session Memory");
      expect(text).toContain("## Workflow Context");
    }
  });

  test("never exceeds a positive budget, marker included", () => {
    const skills = Array.from({ length: 40 }, (_, i) => ({ name: `skill-${i}`, description: "does something useful ".repeat(5) }));
    const memoryIndex = Array.from({ length: 60 }, (_, i) => `- [m${i}](m${i}.md): fact number ${i}`).join("\n");
    for (const budget of [1, 5, 12, 40, 120]) {
      const text = buildSnapshot({ ...base, skills, memoryIndex, skillsTokenBudget: budget, memoryTokenBudget: budget });
      const skillsPart = text.slice(text.indexOf("## Available Skills") >= 0 ? text.indexOf("## Available Skills") : text.length, text.indexOf("# Cross-Session Memory") >= 0 ? text.indexOf("# Cross-Session Memory") : text.length);
      expect(estimateTokens(skillsPart.trimEnd())).toBeLessThanOrEqual(budget);
      const memStart = text.indexOf("# Cross-Session Memory");
      if (memStart >= 0) {
        const memPart = text.slice(memStart, text.indexOf("## Workflow Context")).trimEnd();
        expect(estimateTokens(memPart)).toBeLessThanOrEqual(budget);
      }
    }
  });
});

describe("trimToStrictTokenBudget", () => {
  const note = "cut";

  test("returns text unchanged when it fits", () => {
    expect(trimToStrictTokenBudget("a\nb", 100, note)).toEqual({ text: "a\nb", truncated: false });
  });

  test("keeps whole lines and counts the marker inside the budget", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} with some words`).join("\n");
    for (const budget of [8, 20, 60]) {
      const out = trimToStrictTokenBudget(text, budget, note);
      expect(out.truncated).toBe(true);
      expect(out.text.endsWith("... (cut)")).toBe(true);
      expect(estimateTokens(out.text)).toBeLessThanOrEqual(budget);
    }
  });

  test("cuts an oversized first line, including emoji and CJK", () => {
    for (const unit of ["x", "界", "😀", "é"]) {
      const text = unit.repeat(2000) + "\nsecond";
      for (const budget of [6, 10, 50]) {
        const out = trimToStrictTokenBudget(text, budget, note);
        expect(estimateTokens(out.text)).toBeLessThanOrEqual(budget);
        expect(out.text.endsWith("... (cut)")).toBe(true);
        expect(out.text).not.toContain("second");
      }
    }
  });

  test("emits nothing when the marker alone does not fit or the budget is not positive", () => {
    expect(trimToStrictTokenBudget("x".repeat(500), 1, note)).toEqual({ text: "", truncated: true });
    expect(trimToStrictTokenBudget("x", 0, note)).toEqual({ text: "", truncated: true });
    expect(trimToStrictTokenBudget("x", -3, note)).toEqual({ text: "", truncated: true });
    expect(trimToStrictTokenBudget("x".repeat(500), Number.NaN, note)).toEqual({ text: "", truncated: true });
  });
});

describe("legacy trim keeps its own behaviour", () => {
  test("nonpositive budget disables trimming and the marker may overshoot", () => {
    const text = "x".repeat(1000) + "\nsecond";
    expect(trimSectionToTokenBudget(text, 0)).toEqual({ text, truncated: false });
    expect(trimSectionToTokenBudget(text, -1)).toEqual({ text, truncated: false });
    const trimmed = trimSectionToTokenBudget(text, 1);
    expect(estimateTokens(trimmed.text)).toBeGreaterThan(1);
  });
});

describe("moved helpers", () => {
  test("cross-session memory text is unchanged", () => {
    expect(buildCrossSessionMemory("D")).toBe("# Cross-Session Memory\n\nD\n");
    expect(buildCrossSessionMemory("D", true)).toBe(
      '# Cross-Session Memory\n\nD\n\nUse recall({ query: "..." }) to search file memories, or recall({ name: "..." }) to read one in full.',
    );
  });

  test("native status section only appears when the addon is not available", () => {
    expect(buildNativeStatusSection(null)).toBeNull();
    expect(buildNativeStatusSection({ kind: "available" } as never)).toBeNull();
    expect(buildNativeStatusSection({ kind: "disabled" })).toContain("disabled via config");
    expect(buildNativeStatusSection({ kind: "unavailable", reason: "no binary" } as never)).toContain("unavailable: no binary");
  });
});
