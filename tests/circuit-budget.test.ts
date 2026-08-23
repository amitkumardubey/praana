import { describe, expect, it } from "bun:test";
import { checkCircuitBudget } from "../src/circuit/budget.js";

describe("checkCircuitBudget", () => {
  it("is off when caps are 0", () => {
    expect(checkCircuitBudget({ maxTokens: 0, maxWallMs: 0, tokens: 9e9, elapsedMs: 9e9 })).toBeNull();
  });

  it("returns tokens when over cap", () => {
    expect(checkCircuitBudget({ maxTokens: 100, maxWallMs: 0, tokens: 101, elapsedMs: 1 })).toBe("tokens");
  });

  it("returns time when over cap", () => {
    expect(checkCircuitBudget({ maxTokens: 0, maxWallMs: 50, tokens: 1, elapsedMs: 51 })).toBe("time");
  });
});
