import { describe, it, expect } from "vitest";
import {
  computeContextPressureRatio,
  shouldTriggerAutoCompact,
  effectiveCompileBudget,
  formatContextPressureStats,
  resolveEnginePressureMode,
} from "../src/context-pressure.js";

describe("context-pressure", () => {
  it("computes pressure ratio against usable window", () => {
    expect(computeContextPressureRatio(90_000, 100_000, 10_000)).toBeCloseTo(1.0, 5);
    expect(computeContextPressureRatio(60_000, 100_000, 10_000)).toBeCloseTo(2 / 3);
  });

  it("effectiveCompileBudget caps at model window", () => {
    expect(effectiveCompileBudget(200_000, 128_000, 8_000)).toBe(120_000);
    expect(effectiveCompileBudget(50_000, 128_000, 0)).toBe(50_000);
  });

  it("shouldTriggerAutoCompact respects verbatim_only", () => {
    expect(
      shouldTriggerAutoCompact(0.9, { verbatim_only: true } as any, false),
    ).toEqual({ trigger: false, armed: false });
  });

  it("shouldTriggerAutoCompact uses hysteresis", () => {
    const config = {
      auto_compact_at: 0.75,
      auto_compact_clear_at: 0.55,
    } as any;

    expect(shouldTriggerAutoCompact(0.8, config, false)).toEqual({
      trigger: true,
      armed: true,
    });
    expect(shouldTriggerAutoCompact(0.7, config, true)).toEqual({
      trigger: false,
      armed: true,
    });
    expect(shouldTriggerAutoCompact(0.5, config, true)).toEqual({
      trigger: false,
      armed: false,
    });
  });

  it("formatContextPressureStats shows escalated mode when ratio and mode disagree", () => {
    const lines = formatContextPressureStats(
      {
        weightedTokens: 48_000,
        weightedRatio: 0.6,
        rawTokens: 90_000,
        rawRatio: 0.9,
        effectiveMode: "emergency",
        ratioMode: resolveEnginePressureMode(0.6, {
          compact_at: 0.7,
          emergency_at: 0.85,
        }),
      },
      100_000,
    );
    expect(lines.join("\n")).toContain("60% weighted · emergency (escalated)");
    expect(lines.join("\n")).toContain("90,000");
    expect(lines.join("\n")).toContain("48,000");
  });
});
