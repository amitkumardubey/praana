import { describe, expect, test } from "bun:test";
import { buildStableSystemFrame, buildSharedAgentPolicy, trimAgentsContext, trimSectionToTokenBudget } from "../src/prompt/frame.js";
import { estimateTokens } from "../src/token-estimate.js";

const input = {
  identity: "You are PRAANA",
  appVersion: "v1.2.3",
  sharedPolicy: "## Policy\n\nFollow verified evidence.",
  projectRules: "  # Project rules\nUse strict TypeScript.  ",
  projectRulesTokenBudget: 100,
};

describe("stable system frame", () => {
  test("renders only explicit stable inputs in layer order", () => {
    expect(buildStableSystemFrame(input)).toBe("You are PRAANA v1.2.3\n\n## Policy\n\nFollow verified evidence.\n\n## Project Context\n\n# Project rules\nUse strict TypeScript.");
    expect(buildStableSystemFrame(input)).not.toMatch(/Current date|Session ID|Working directory|Native Addon/);
  });

  test("is deterministic without consulting the environment or clock", () => {
    const before = structuredClone(input);
    expect(buildStableSystemFrame(input)).toBe(buildStableSystemFrame({ ...input }));
    expect(input).toEqual(before);
  });

  test("omits empty policy and rules and disables rules at nonpositive caps", () => {
    for (const cap of [0, -1]) {
      expect(buildStableSystemFrame({ ...input, sharedPolicy: " ", projectRulesTokenBudget: cap })).toBe("You are PRAANA v1.2.3");
    }
    expect(buildStableSystemFrame({ ...input, projectRules: "\n " })).not.toContain("## Project Context");
  });

  test("caps the project rules including an oversized first line and Unicode", () => {
    for (const budget of [1, 10, 50]) {
      const base = buildStableSystemFrame({ ...input, projectRules: null });
      const frame = buildStableSystemFrame({ ...input, projectRules: "界😀".repeat(1000), projectRulesTokenBudget: budget });
      const rules = frame.slice(base.length + "\n\n## Project Context\n\n".length);
      expect(estimateTokens(rules)).toBeLessThanOrEqual(budget);
    }
  });
});

describe("moved legacy policy helpers", () => {
  test("keeps the recall-enabled policy distinction", () => {
    expect(buildSharedAgentPolicy().at(-1)).toBe("Use search_session_log for other session events.");
    expect(buildSharedAgentPolicy(true).at(-1)).toContain("recall searches cross-session file memories");
  });

  test("retains legacy disabled trimming at zero and negative budgets", () => {
    for (const budget of [0, -10]) {
      expect(trimSectionToTokenBudget("x".repeat(100), budget)).toEqual({ text: "x".repeat(100), truncated: false });
      expect(trimAgentsContext("  rules  ", budget)).toEqual({ text: "rules", truncated: false });
    }
  });

  test("retains legacy oversized-first-line and out-of-budget marker behaviour", () => {
    const text = "x".repeat(1000) + "\nsecond line";
    const trimmed = trimSectionToTokenBudget(text, 1);
    expect(trimmed).toEqual({ text: "x".repeat(1000) + "\n... (memory section truncated to token budget)", truncated: true });
    expect(estimateTokens(trimmed.text)).toBeGreaterThan(1);
    expect(trimAgentsContext(null, 1)).toEqual({ text: null, truncated: false });
  });

  test("never leaves half of a surrogate pair when the legacy slice splits one", () => {
    const rules = "# a" + "𝒜".repeat(200);
    let legacySplit = false;
    for (let budget = 1; budget <= 60; budget++) {
      if (!(trimAgentsContext(rules, budget).text ?? "").isWellFormed()) legacySplit = true;
      const frame = buildStableSystemFrame({ ...input, projectRules: rules, projectRulesTokenBudget: budget });
      expect(frame.isWellFormed()).toBe(true);
    }
    // Guards the test itself: the legacy helper really does split a pair for some budget.
    expect(legacySplit).toBe(true);
  });
});
