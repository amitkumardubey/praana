import { describe, it, expect } from "bun:test";
import {
  DENSITY_WEIGHTS,
  effectiveTokens,
  sumEffectiveTokens,
} from "../src/context-engine/density.js";

describe("density", () => {
  it("assigns lower weight to compressible sections", () => {
    expect(DENSITY_WEIGHTS.finding).toBeLessThan(DENSITY_WEIGHTS.decision);
    expect(DENSITY_WEIGHTS.activity).toBeLessThan(DENSITY_WEIGHTS.constraint);
    expect(DENSITY_WEIGHTS.fixed_error).toBeLessThan(DENSITY_WEIGHTS.open_error);
  });

  it("computes effective tokens as raw * weight", () => {
    expect(effectiveTokens(1000, "finding")).toBe(250);
    expect(effectiveTokens(1000, "decision")).toBe(1000);
    expect(effectiveTokens(1000, "verbatim_turn")).toBe(900);
  });

  it("sums effective tokens across sections", () => {
    const total = sumEffectiveTokens([
      { tokens: 1000, kind: "finding" },
      { tokens: 500, kind: "decision" },
    ]);
    expect(total).toBe(750);
  });
});
