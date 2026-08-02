import { describe, expect, it } from "bun:test";
import { generateReport, formatReport } from "../../src/benchmark/report.js";
import type { SessionBenchmark } from "../../src/benchmark/types.js";

describe("generateReport", () => {
  it("should compute summary averages", () => {
    const sessions: SessionBenchmark[] = [
      {
        sessionId: "s1",
        cwd: "/test",
        totalTurns: 5,
        avgTokenRatio: 0.7,
        avgCompressionEfficiency: 0.3,
        turns: [],
        pressureDistribution: { normal: 4, compact: 1, emergency: 0 },
        avgIncludedScore: 0.6,
        avgExcludedUnits: 2,
      },
      {
        sessionId: "s2",
        cwd: "/test",
        totalTurns: 3,
        avgTokenRatio: 0.6,
        avgCompressionEfficiency: 0.4,
        turns: [],
        pressureDistribution: { normal: 2, compact: 1, emergency: 0 },
        avgIncludedScore: 0.7,
        avgExcludedUnits: 3,
      },
    ];

    const report = generateReport(sessions);
    expect(report.summary.totalSessions).toBe(2);
    expect(report.summary.totalTurns).toBe(8);
    // Weighted average: (0.7*5 + 0.6*3) / 8 = (3.5 + 1.8) / 8 = 5.3/8 = 0.6625
    expect(report.summary.avgTokenRatio).toBeCloseTo(0.6625, 3);
    // Weighted average: (0.3*5 + 0.4*3) / 8 = (1.5 + 1.2) / 8 = 2.7/8 = 0.3375
    expect(report.summary.avgCompressionEfficiency).toBeCloseTo(0.3375, 3);
  });

  it("should handle empty sessions", () => {
    const report = generateReport([]);
    expect(report.summary.totalSessions).toBe(0);
    expect(report.summary.totalTurns).toBe(0);
    expect(report.summary.avgTokenRatio).toBe(0);
  });
});

describe("formatReport", () => {
  it("should format report as readable text", () => {
    const sessions: SessionBenchmark[] = [
      {
        sessionId: "s1",
        cwd: "/test",
        totalTurns: 5,
        avgTokenRatio: 0.7,
        avgCompressionEfficiency: 0.3,
        turns: [],
        pressureDistribution: { normal: 4, compact: 1, emergency: 0 },
        avgIncludedScore: 0.6,
        avgExcludedUnits: 2,
      },
    ];

    const report = generateReport(sessions);
    const formatted = formatReport(report);

    expect(formatted).toContain("# Context Engine Benchmark Report");
    expect(formatted).toContain("Sessions benchmarked");
    expect(formatted).toContain("Session s1");
    expect(formatted).toContain("30.0%"); // compression efficiency as percentage
  });
});
