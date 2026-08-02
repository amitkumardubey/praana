import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaySession } from "./session-replay.js";
import { compareTurn } from "./comparison.js";
import { generateReport, formatReport } from "./report.js";
import type { SessionBenchmark } from "./types.js";
import type { ContextEngineConfig } from "../types.js";

const DEFAULT_ENGINE_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 400,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: {
    w_recency: 0.3,
    w_relevance: 0.5,
    w_pin: 0.1,
    w_hydrate_boost: 0.1,
    w_semantic: 0,
  },
  pressure: {
    compact_at: 0.8,
    emergency_at: 0.95,
  },
};

async function findSessions(baseDir: string): Promise<string[]> {
  const sessions: string[] = [];
  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const eventsPath = join(baseDir, entry.name, "events.jsonl");
        try {
          await readFile(eventsPath, "utf-8");
          sessions.push(join(baseDir, entry.name));
        } catch {
          // No events.jsonl, skip
        }
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return sessions;
}

async function benchmarkSession(
  sessionDir: string,
  engineConfig: ContextEngineConfig,
  maxTurns: number,
): Promise<SessionBenchmark> {
  const eventsPath = join(sessionDir, "events.jsonl");
  const rawEvents = await readFile(eventsPath, "utf-8");
  const events = rawEvents.split("\n").filter(Boolean).map((line) => JSON.parse(line));

  const turns = replaySession(events);
  const turnsToProcess = maxTurns > 0 ? turns.slice(0, maxTurns) : turns;

  const comparisons = [];
  let totalTokenRatio = 0;
  let totalCompressionEfficiency = 0;
  let totalIncludedScore = 0;
  let totalExcludedUnits = 0;
  const pressureDistribution = { normal: 0, compact: 0, emergency: 0 };

  for (let i = 0; i < turnsToProcess.length; i++) {
    const comparison = await compareTurn(
      turns,
      i + 1,
      sessionDir,
      sessionDir.split("/").pop() ?? "unknown",
      engineConfig,
    );
    comparisons.push(comparison);
    totalTokenRatio += comparison.tokenRatio;
    totalCompressionEfficiency += comparison.compressionEfficiency;

    if (comparison.engine.pressureMode) {
      pressureDistribution[comparison.engine.pressureMode]++;
    }

    if (comparison.engine.scoredUnits) {
      const included = comparison.engine.scoredUnits.included;
      if (included.length > 0) {
        totalIncludedScore += included.reduce((sum, u) => sum + u.score, 0) / included.length;
      }
      totalExcludedUnits += comparison.engine.scoredUnits.excluded.length;
    }
  }

  const turnCount = turnsToProcess.length || 1;

  return {
    sessionId: sessionDir.split("/").pop() ?? "unknown",
    cwd: sessionDir,
    totalTurns: turnsToProcess.length,
    avgTokenRatio: totalTokenRatio / turnCount,
    avgCompressionEfficiency: totalCompressionEfficiency / turnCount,
    turns: comparisons,
    pressureDistribution,
    avgIncludedScore: totalIncludedScore / turnCount,
    avgExcludedUnits: totalExcludedUnits / turnCount,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const sessionsArg = args.find((a) => a.startsWith("--sessions="));
  const maxTurnsArg = args.find((a) => a.startsWith("--max-turns="));
  const outputArg = args.find((a) => a.startsWith("--output="));

  const sessionsDir = sessionsArg?.split("=")[1] ?? join(process.env["HOME"] ?? "~", ".praana/sessions");
  const maxTurns = maxTurnsArg ? parseInt(maxTurnsArg.split("=")[1]) : 0;
  const outputPath = outputArg?.split("=")[1];

  console.log(`Scanning sessions in: ${sessionsDir}`);
  const sessionDirs = await findSessions(sessionsDir);

  if (sessionDirs.length === 0) {
    console.log("No sessions found. Run some sessions first.");
    process.exit(1);
  }

  console.log(`Found ${sessionDirs.length} sessions`);

  const engineConfig = DEFAULT_ENGINE_CONFIG;
  const benchmarks: SessionBenchmark[] = [];

  for (const dir of sessionDirs) {
    const sessionId = dir.split("/").pop() ?? "unknown";
    console.log(`Benchmarking: ${sessionId}`);
    try {
      const benchmark = await benchmarkSession(dir, engineConfig, maxTurns);
      benchmarks.push(benchmark);
      console.log(`  Turns: ${benchmark.totalTurns}, Token ratio: ${benchmark.avgTokenRatio.toFixed(3)}, Compression: ${(benchmark.avgCompressionEfficiency * 100).toFixed(1)}%`);
    } catch (err) {
      console.error(`  Failed: ${err}`);
    }
  }

  const report = generateReport(benchmarks);
  const formatted = formatReport(report);

  console.log("\n" + formatted);

  if (outputPath) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${outputPath}`);
  }
}

main().catch(console.error);
