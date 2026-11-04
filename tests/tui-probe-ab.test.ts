import { expect, test } from "bun:test";
import { summarize, formatTable, checkThresholds } from "../scripts/tui-probe/run-ab";
import type { Report } from "../scripts/tui-probe/analyze";

const report = (regressions: number, styleFlips: number): Report => ({ sampleCount: 1000, achievedHz: 100, unmatchedRatio: 0.1, regressions, styleFlips, scrollReversals: 0, aba: 0, durationMs: 1, distinctScreens: 1, samples: [], offenders: [] });
test("summarizes counts and per-thousand rates across runs", () => {
  const result = summarize([report(1, 2), report(3, 6)]);
  expect(result.regressions).toEqual({ mean: 2, min: 1, max: 3, rate: 2 });
  expect(result.styleFlips.rate).toBe(4);
  expect(formatTable("A", result, "B", result)).toContain("regressions");
});
test("checks defaults and optional style rate", () => {
  expect(checkThresholds([report(0, 5)], {})).toEqual([]);
  expect(checkThresholds([report(1, 5)], { styleFlips: 4 })).toEqual(["regressions", "styleFlips"]);
});
