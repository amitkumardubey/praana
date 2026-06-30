import { describe, it, expect } from "bun:test";
import {
  getCodingBudgetAllocation,
  CODING_DEFAULT_BUDGET_ALLOCATION,
  codingDomainClassifier,
} from "../src/domain/coding-domain.js";
import type { BudgetAllocation } from "../src/domain/types.js";

function expectSumsToOne(alloc: BudgetAllocation) {
  const sum = alloc.errors + alloc.verbatimTurns + alloc.decisions + alloc.artifacts + alloc.narrative;
  expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
}

describe("getCodingBudgetAllocation", () => {
  it("debugging allocation: errors=0.25, verbatimTurns=0.35, decisions=0.10, artifacts=0.20, narrative=0.10", () => {
    const a = getCodingBudgetAllocation("debugging");
    expect(a).toEqual({ errors: 0.25, verbatimTurns: 0.35, decisions: 0.10, artifacts: 0.20, narrative: 0.10 });
  });

  it("testing allocation: errors=0.10, verbatimTurns=0.25, decisions=0.15, artifacts=0.35, narrative=0.15", () => {
    const a = getCodingBudgetAllocation("testing");
    expect(a).toEqual({ errors: 0.10, verbatimTurns: 0.25, decisions: 0.15, artifacts: 0.35, narrative: 0.15 });
  });

  it("implementing allocation: errors=0.05, verbatimTurns=0.20, decisions=0.20, artifacts=0.40, narrative=0.15", () => {
    const a = getCodingBudgetAllocation("implementing");
    expect(a).toEqual({ errors: 0.05, verbatimTurns: 0.20, decisions: 0.20, artifacts: 0.40, narrative: 0.15 });
  });

  it("refactoring allocation: errors=0.10, verbatimTurns=0.25, decisions=0.25, artifacts=0.30, narrative=0.10", () => {
    const a = getCodingBudgetAllocation("refactoring");
    expect(a).toEqual({ errors: 0.10, verbatimTurns: 0.25, decisions: 0.25, artifacts: 0.30, narrative: 0.10 });
  });

  it("general returns default allocation", () => {
    expect(getCodingBudgetAllocation("general")).toEqual(CODING_DEFAULT_BUDGET_ALLOCATION);
  });

  it("reviewing returns default allocation", () => {
    expect(getCodingBudgetAllocation("reviewing")).toEqual(CODING_DEFAULT_BUDGET_ALLOCATION);
  });

  it("unknown task type returns default allocation", () => {
    expect(getCodingBudgetAllocation("unknown_domain_task")).toEqual(CODING_DEFAULT_BUDGET_ALLOCATION);
  });

  it("all defined task type allocations sum to 1.0", () => {
    for (const type of ["debugging", "testing", "implementing", "refactoring", "general", "reviewing"]) {
      expectSumsToOne(getCodingBudgetAllocation(type));
    }
  });

  it("codingDomainClassifier.getBudgetAllocation delegates to getCodingBudgetAllocation", () => {
    expect(codingDomainClassifier.getBudgetAllocation("debugging"))
      .toEqual(getCodingBudgetAllocation("debugging"));
  });

  it("returned allocations are independent copies (mutation safety)", () => {
    const a = getCodingBudgetAllocation("general");
    a.errors = 0.99;
    expect(a).not.toEqual(CODING_DEFAULT_BUDGET_ALLOCATION);
    // Must not affect the constant or subsequent calls
    expect(CODING_DEFAULT_BUDGET_ALLOCATION.errors).toBe(0.10);
    expect(getCodingBudgetAllocation("general").errors).toBe(0.10);
  });
});
