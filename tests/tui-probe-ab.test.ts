import { expect, test } from "bun:test";
import {
  summarize,
  formatTable,
  checkThresholds,
  resolveAbEnv,
} from "../scripts/tui-probe/run-ab";
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
test("resolveAbEnv splits common, side-A, and side-B env args preserving common-first order", () => {
  expect(resolveAbEnv([])).toEqual({ envA: [], envB: [] });

  const args = [
    "--env-a",
    "A_BEFORE=1",
    "--env",
    "COMMON=1",
    "--env-a",
    "BATCH=0",
    "--env-b",
    "BATCH=33",
    "--env",
    "COMMON2=2",
  ];
  expect(resolveAbEnv(args)).toEqual({
    envA: ["COMMON=1", "COMMON2=2", "A_BEFORE=1", "BATCH=0"],
    envB: ["COMMON=1", "COMMON2=2", "BATCH=33"],
  });
});

test("resolveAbEnv throws on missing value for env flags", () => {
  expect(() => resolveAbEnv(["--env"])).toThrow("Missing value for --env");
  expect(() => resolveAbEnv(["--env-a"])).toThrow("Missing value for --env-a");
  expect(() => resolveAbEnv(["--env-b"])).toThrow("Missing value for --env-b");
  expect(() => resolveAbEnv(["--env", "--env-a", "X=1"])).toThrow("Missing value for --env");
  expect(() => resolveAbEnv(["--env-a", "--env-b", "X=1"])).toThrow("Missing value for --env-a");
});
