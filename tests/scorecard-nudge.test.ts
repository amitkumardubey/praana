import { describe, it, expect } from "bun:test";
import { buildScorecardNudge } from "../src/turn.js";

describe("buildScorecardNudge", () => {
  const zero = { repeatFileReads: 0, noOpTools: 0, churnInterventions: 0 };

  it("returns undefined when start or end is missing", () => {
    expect(buildScorecardNudge(null, zero, 0, 0)).toBeUndefined();
    expect(buildScorecardNudge(zero, undefined, 0, 0)).toBeUndefined();
  });

  it("prioritizes churn interventions over other tips", () => {
    const tip = buildScorecardNudge(
      zero,
      { repeatFileReads: 3, noOpTools: 2, churnInterventions: 1 },
      4,
      0,
    );
    expect(tip).toMatch(/churn detected/);
  });

  it("tips on repeat reads when no churn fired this turn", () => {
    const tip = buildScorecardNudge(
      zero,
      { repeatFileReads: 2, noOpTools: 0, churnInterventions: 0 },
      0,
      0,
    );
    expect(tip).toMatch(/re-read files/);
  });

  it("tips on no-op tools", () => {
    const tip = buildScorecardNudge(
      zero,
      { repeatFileReads: 0, noOpTools: 1, churnInterventions: 0 },
      0,
      0,
    );
    expect(tip).toMatch(/no changes/);
  });

  it("tips on low recall hit rate", () => {
    const tip = buildScorecardNudge(zero, zero, 4, 1);
    expect(tip).toMatch(/low hit rate/);
  });

  it("returns undefined when nothing fired", () => {
    expect(buildScorecardNudge(zero, zero, 0, 0)).toBeUndefined();
    expect(buildScorecardNudge(zero, zero, 2, 2)).toBeUndefined();
  });
});
