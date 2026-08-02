import type { BenchmarkReport, SessionBenchmark } from "./types.js";

/**
 * Generate a benchmark report from session benchmarks.
 */
export function generateReport(sessions: SessionBenchmark[]): BenchmarkReport {
  const totalTurns = sessions.reduce((sum, s) => sum + s.totalTurns, 0);
  const avgTokenRatio = totalTurns > 0
    ? sessions.reduce((sum, s) => sum + s.avgTokenRatio * s.totalTurns, 0) / totalTurns
    : 0;
  const avgCompressionEfficiency = totalTurns > 0
    ? sessions.reduce((sum, s) => sum + s.avgCompressionEfficiency * s.totalTurns, 0) / totalTurns
    : 0;
  const avgIncludedScore = totalTurns > 0
    ? sessions.reduce((sum, s) => sum + s.avgIncludedScore * s.totalTurns, 0) / totalTurns
    : 0;

  return {
    sessions,
    summary: {
      totalSessions: sessions.length,
      totalTurns,
      avgTokenRatio,
      avgCompressionEfficiency,
      avgIncludedScore,
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Format a benchmark report as human-readable text.
 */
export function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [
    "# Context Engine Benchmark Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Sessions benchmarked | ${report.summary.totalSessions} |`,
    `| Total turns | ${report.summary.totalTurns} |`,
    `| Avg token ratio (engine/classic) | ${report.summary.avgTokenRatio.toFixed(3)} |`,
    `| Avg compression efficiency | ${(report.summary.avgCompressionEfficiency * 100).toFixed(1)}% |`,
    `| Avg included unit score | ${report.summary.avgIncludedScore.toFixed(3)} |`,
    "",
    "## Per-Session Results",
    "",
  ];

  for (const session of report.sessions) {
    lines.push(`### Session ${session.sessionId}`);
    lines.push("");
    lines.push(`- Turns: ${session.totalTurns}`);
    lines.push(`- Avg token ratio: ${session.avgTokenRatio.toFixed(3)}`);
    lines.push(`- Compression: ${(session.avgCompressionEfficiency * 100).toFixed(1)}%`);
    lines.push(`- Pressure: normal=${session.pressureDistribution.normal} compact=${session.pressureDistribution.compact} emergency=${session.pressureDistribution.emergency}`);
    lines.push(`- Avg excluded units: ${session.avgExcludedUnits.toFixed(1)}`);
    lines.push("");
  }

  return lines.join("\n");
}
