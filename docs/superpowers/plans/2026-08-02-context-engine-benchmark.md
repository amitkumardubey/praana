# Context Engine Benchmark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a benchmarking system that measures the context engine's value over classic mode — token efficiency, relevance, and prompt quality — with reproducible test sessions and a comparison report.

**Architecture:** A benchmark harness that takes recorded sessions (event logs), replays them through both engines, and produces a side-by-side comparison. Sessions are the source of truth — no synthetic data. The harness is a CLI tool (`bun run benchmark`) that reads session directories, compiles each turn through both engines, and outputs a JSON report + human-readable summary.

**Tech Stack:** TypeScript, Bun, existing session infrastructure (event-log, compile-classic, engine-compiler), SQLite for storing benchmark results.

---

## Why This Design

The classic engine (`compile-classic.ts`) dumps the full verbatim conversation history into the prompt. The context engine (`engine-compiler.ts`) scores, selects, and structures context units. To measure the benefit, we need to compare the *output prompts* from both engines for the same session state.

We don't need to run the LLM — we just need to compare what each engine would send. This makes benchmarks fast (no API calls), reproducible, and cheap.

**Key insight:** We can replay a recorded session turn-by-turn, feed the same state into both compilers, and compare the resulting prompts. This gives us:
- Token counts per turn for each engine
- Which context units the engine selected vs what classic includes
- How pressure modes affect the engine's output
- The "information density" gap between the two approaches

---

## Metrics

### Primary Metrics (computed per session, averaged across turns)

| Metric | What it measures | How to compute |
|--------|-----------------|----------------|
| **Token ratio** | Engine prompt size / classic prompt size | `engine.totalTokens / classic.totalTokens` per turn, averaged |
| **Compression efficiency** | How much the engine reduces tokens while keeping relevant content | `(classic.totalTokens - engine.totalTokens) / classic.totalTokens` |
| **Context utilization** | % of engine's included units that are "relevant" (score > threshold) | Count units with `score > 0.3` / total included units |
| **Pressure frequency** | How often the engine hits compact/emergency mode | Count turns with `pressureMode !== "normal"` / total turns |
| **Verbatim coverage** | What % of classic's verbatim history appears in engine's output | Text similarity or token overlap |

### Secondary Metrics (informational)

| Metric | What it measures |
|--------|-----------------|
| **Score distribution** | Histogram of unit scores (are most units high or low relevance?) |
| **Band fill rates** | How full each token budget band is (verbatim, scored recent, scored older) |
| **Checkpoint size** | Token count of the checkpoint section over time |
| **Excluded units** | How many units were scored but excluded (scored > budget) |

---

## File Structure

```
src/benchmark/
  index.ts              — CLI entry: parse args, load sessions, run comparison
  session-replay.ts     — Replay recorded session events into compiler inputs
  comparison.ts         — Run both compilers, compute metrics, generate report
  report.ts             — Format comparison results as JSON + human-readable text
  types.ts              — Benchmark-specific types
tests/benchmark/
  session-replay.test.ts
  comparison.test.ts
  report.test.ts
```

---

### Task 1: Define benchmark types

**Files:**
- Create: `src/benchmark/types.ts`

- [ ] **Step 1: Create the types file**

```typescript
// src/benchmark/types.ts

import type { CompileMetrics } from "../compiler.js";
import type { PressureMode, ScoredContextUnit } from "../context-engine/types.js";

/** A single turn's comparison between classic and engine compilation. */
export interface TurnComparison {
  turnNumber: number;
  classic: CompilationSnapshot;
  engine: CompilationSnapshot;
  /** Token ratio: engine / classic (< 1 means engine is smaller). */
  tokenRatio: number;
  /** Compression efficiency: (classic - engine) / classic. */
  compressionEfficiency: number;
}

/** Snapshot of a single compilation. */
export interface CompilationSnapshot {
  totalTokens: number;
  metrics: CompileMetrics;
  /** For engine: the scored units that were included/excluded. */
  scoredUnits?: {
    included: ScoredContextUnit[];
    excluded: ScoredContextUnit[];
  };
  /** For engine: the pressure mode at compilation time. */
  pressureMode?: PressureMode;
}

/** Aggregated metrics for a full session. */
export interface SessionBenchmark {
  sessionId: string;
  cwd: string;
  totalTurns: number;
  /** Average token ratio across turns (engine / classic). */
  avgTokenRatio: number;
  /** Average compression efficiency across turns. */
  avgCompressionEfficiency: number;
  /** Turn-by-turn comparisons. */
  turns: TurnComparison[];
  /** Pressure mode distribution. */
  pressureDistribution: Record<PressureMode, number>;
  /** Average score of included units (engine only). */
  avgIncludedScore: number;
  /** Average number of excluded units per turn (engine only). */
  avgExcludedUnits: number;
}

/** Full benchmark report across multiple sessions. */
export interface BenchmarkReport {
  sessions: SessionBenchmark[];
  summary: {
    totalSessions: number;
    totalTurns: number;
    /** Grand average token ratio across all sessions and turns. */
    avgTokenRatio: number;
    avgCompressionEfficiency: number;
    avgIncludedScore: number;
  };
  generatedAt: string;
}

/** Options for running a benchmark. */
export interface BenchmarkOptions {
  /** Session directories to benchmark (paths to events.jsonl). */
  sessions: string[];
  /** Engine config to use for context engine compilation. */
  engineConfig: string;
  /** Max turns to process per session (0 = all). */
  maxTurns?: number;
  /** Output path for the report JSON. */
  outputPath?: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/benchmark/types.ts
git commit -m "feat(benchmark): add benchmark type definitions"
```

---

### Task 2: Build session replay

**Files:**
- Create: `src/benchmark/session-replay.ts`
- Create: `tests/benchmark/session-replay.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/benchmark/session-replay.test.ts
import { describe, expect, it } from "bun:test";
import { replaySession } from "../../src/benchmark/session-replay.js";
import type { Event } from "../../src/types.js";

describe("replaySession", () => {
  it("should replay events into turn snapshots", () => {
    const events: Event[] = [
      { kind: "user_message", payload: { text: "fix the bug" }, timestamp: 1 },
      { kind: "agent_message", payload: { text: "I'll look into it" }, timestamp: 2 },
      { kind: "tool_call", payload: { tool: "read_file", args: { path: "src/foo.ts" } }, timestamp: 3 },
      { kind: "tool_result", payload: { tool: "read_file", result: "file contents" }, timestamp: 4 },
      { kind: "user_message", payload: { text: "now test it" }, timestamp: 5 },
    ];

    const turns = replaySession(events);
    expect(turns.length).toBe(2); // Two user messages = two turns
    expect(turns[0].userMessage).toBe("fix the bug");
    expect(turns[1].userMessage).toBe("now test it");
  });

  it("should track tool calls per turn", () => {
    const events: Event[] = [
      { kind: "user_message", payload: { text: "read foo" }, timestamp: 1 },
      { kind: "tool_call", payload: { tool: "read_file", args: { path: "foo.ts" } }, timestamp: 2 },
      { kind: "tool_result", payload: { tool: "read_file", result: "contents" }, timestamp: 3 },
      { kind: "agent_message", payload: { text: "done" }, timestamp: 4 },
    ];

    const turns = replaySession(events);
    expect(turns[0].toolCalls.length).toBe(1);
    expect(turns[0].toolCalls[0].tool).toBe("read_file");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/benchmark/session-replay.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement session replay**

```typescript
// src/benchmark/session-replay.ts
import type { Event, ToolCallRecord } from "../types.js";
import type { TurnRecord } from "../context-engine/types.js";

export interface ReplayTurn {
  turnNumber: number;
  userMessage: string;
  assistantMessage: string;
  toolCalls: ToolCallRecord[];
  filesRead: string[];
  filesWritten: string[];
  errors: string[];
}

/**
 * Replay a list of events into turn snapshots.
 * Each user_message starts a new turn; tool calls and results are grouped within.
 */
export function replaySession(events: Event[]): ReplayTurn[] {
  const turns: ReplayTurn[] = [];
  let currentTurn: ReplayTurn | null = null;

  for (const event of events) {
    switch (event.kind) {
      case "user_message": {
        if (currentTurn) {
          turns.push(currentTurn);
        }
        currentTurn = {
          turnNumber: turns.length + 1,
          userMessage: (event.payload.text as string) ?? "",
          assistantMessage: "",
          toolCalls: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
        };
        break;
      }
      case "agent_message": {
        if (currentTurn) {
          currentTurn.assistantMessage = (event.payload.text as string) ?? "";
        }
        break;
      }
      case "tool_call": {
        if (currentTurn) {
          currentTurn.toolCalls.push({
            tool: (event.payload.tool as string) ?? "unknown",
            args: (event.payload.args as Record<string, unknown>) ?? {},
            isError: false,
          });
        }
        break;
      }
      case "tool_result": {
        if (currentTurn) {
          const lastTool = currentTurn.toolCalls[currentTurn.toolCalls.length - 1];
          if (lastTool) {
            lastTool.resultText = typeof event.payload.result === "string"
              ? event.payload.result
              : JSON.stringify(event.payload.result);
          }
          // Track file operations
          const tool = (event.payload.tool as string) ?? "";
          const args = (event.payload.args as Record<string, unknown>) ?? {};
          if (tool === "read_file" && typeof args.path === "string") {
            currentTurn.filesRead.push(args.path);
          }
          if (tool === "write_file" && typeof args.path === "string") {
            currentTurn.filesWritten.push(args.path);
          }
        }
        break;
      }
    }
  }

  if (currentTurn) {
    turns.push(currentTurn);
  }

  return turns;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/benchmark/session-replay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/session-replay.ts tests/benchmark/session-replay.test.ts
git commit -m "feat(benchmark): add session replay for benchmark input"
```

---

### Task 3: Build comparison engine

**Files:**
- Create: `src/benchmark/comparison.ts`
- Create: `tests/benchmark/comparison.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/benchmark/comparison.test.ts
import { describe, expect, it } from "bun:test";
import { compareTurn } from "../../src/benchmark/comparison.js";
import { compileClassicWithMetrics } from "../../src/compile-classic.js";
import { compileEngineWithMetrics } from "../../src/context-engine/engine-compiler.js";
import type { ReplayTurn } from "../../src/benchmark/session-replay.js";
import type { ContextEngineConfig } from "../../src/types.js";

const mockConfig: ContextEngineConfig = {
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

describe("compareTurn", () => {
  it("should produce smaller engine prompt than classic", async () => {
    const turns: ReplayTurn[] = [
      {
        turnNumber: 1,
        userMessage: "fix the bug in auth.ts",
        assistantMessage: "I'll look into it",
        toolCalls: [{ tool: "read_file", args: { path: "auth.ts" }, isError: false, resultText: "auth code" }],
        filesRead: ["auth.ts"],
        filesWritten: [],
        errors: [],
      },
      {
        turnNumber: 2,
        userMessage: "now test it",
        assistantMessage: "running tests",
        toolCalls: [{ tool: "shell", args: { command: "bun test" }, isError: false, resultText: "all pass" }],
        filesRead: [],
        filesWritten: [],
        errors: [],
      },
    ];

    const comparison = await compareTurn(turns, 2, "/test", "session-1", mockConfig);
    // Engine should be smaller or equal (with only 2 turns, difference may be small)
    expect(comparison.engine.totalTokens).toBeGreaterThan(0);
    expect(comparison.classic.totalTokens).toBeGreaterThan(0);
    expect(comparison.tokenRatio).toBeGreaterThan(0);
    expect(comparison.tokenRatio).toBeLessThanOrEqual(1.5); // Should not be wildly larger
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/benchmark/comparison.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement comparison**

```typescript
// src/benchmark/comparison.ts
import type { ContextEngineConfig } from "../types.js";
import type { TurnComparison, CompilationSnapshot } from "./types.js";
import type { ReplayTurn } from "./session-replay.js";
import { compileClassicWithMetrics } from "../compile-classic.js";
import { compileEngineWithMetrics, type EngineCompileInput } from "../context-engine/engine-compiler.js";
import { createEmptyCheckpointState, type SessionCheckpoint } from "../context-engine/checkpoint.js";
import type { StateGraph } from "../state-graph.js";

/**
 * Compare classic vs engine compilation for a single turn.
 * Uses the replayed turns to build inputs for both compilers.
 */
export async function compareTurn(
  turns: ReplayTurn[],
  currentTurn: number,
  cwd: string,
  sessionId: string,
  engineConfig: ContextEngineConfig,
): Promise<TurnComparison> {
  const events = turnsToEvents(turns);

  // Classic compilation
  const classicResult = compileClassicWithMetrics({
    cwd,
    sessionId,
    toolSchemas: [],
    events,
    userInput: turns[currentTurn - 1]?.userMessage,
  });

  const classicSnapshot: CompilationSnapshot = {
    totalTokens: classicResult.metrics.totalTokens,
    metrics: classicResult.metrics,
  };

  // Engine compilation
  const turnRecords = turns.map((t) => ({
    turn: t.turnNumber,
    userMessage: t.userMessage,
    assistantMessage: t.assistantMessage,
    toolCalls: t.toolCalls,
    artifactIds: [],
    filesRead: t.filesRead,
    filesWritten: t.filesWritten,
    errors: t.errors,
    tokenCount: 0,
    timestamp: Date.now(),
  }));

  const checkpoint: SessionCheckpoint = {
    version: 1,
    state: createEmptyCheckpointState(),
  };

  const engineInput: EngineCompileInput = {
    cwd,
    sessionId,
    toolSchemas: [],
    events,
    userInput: turns[currentTurn - 1]?.userMessage,
    currentTurn: currentTurn - 1,
    turnRecords,
    engineConfig,
    checkpoint,
    tokenBudget: 128_000,
    contextWindowTokens: 200_000,
  };

  const engineResult = await compileEngineWithMetrics(engineInput);

  const engineSnapshot: CompilationSnapshot = {
    totalTokens: engineResult.metrics.totalTokens,
    metrics: engineResult.metrics,
    scoredUnits: {
      included: engineResult.includedScored,
      excluded: engineResult.scoreRecords
        .filter((r) => !r.included)
        .map((r) => ({
          id: r.unitId,
          type: r.type,
          content: "",
          tokens: r.tokens,
          sourceTurn: r.turn,
          score: r.score,
          pinned: false,
          artifactRefs: [],
          breakdown: r.breakdown,
        })),
    },
    pressureMode: engineResult.pressureMode,
  };

  const tokenRatio = engineResult.metrics.totalTokens / classicResult.metrics.totalTokens;
  const compressionEfficiency = (classicResult.metrics.totalTokens - engineResult.metrics.totalTokens) / classicResult.metrics.totalTokens;

  return {
    turnNumber: currentTurn,
    classic: classicSnapshot,
    engine: engineSnapshot,
    tokenRatio,
    compressionEfficiency,
  };
}

/** Convert replay turns back to events for classic compiler. */
function turnsToEvents(turns: ReplayTurn[]): Event[] {
  const events: Event[] = [];
  for (const turn of turns) {
    events.push({ kind: "user_message", payload: { text: turn.userMessage }, timestamp: turn.turnNumber });
    for (const tc of turn.toolCalls) {
      events.push({ kind: "tool_call", payload: { tool: tc.tool, args: tc.args }, timestamp: turn.turnNumber });
      if (tc.resultText) {
        events.push({ kind: "tool_result", payload: { tool: tc.tool, result: tc.resultText }, timestamp: turn.turnNumber });
      }
    }
    if (turn.assistantMessage) {
      events.push({ kind: "agent_message", payload: { text: turn.assistantMessage }, timestamp: turn.turnNumber });
    }
  }
  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/benchmark/comparison.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/comparison.ts tests/benchmark/comparison.test.ts
git commit -m "feat(benchmark): add classic vs engine comparison"
```

---

### Task 4: Build report generator

**Files:**
- Create: `src/benchmark/report.ts`
- Create: `tests/benchmark/report.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/benchmark/report.test.ts
import { describe, expect, it } from "bun:test";
import { generateReport } from "../../src/benchmark/report.js";
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
    expect(report.summary.avgTokenRatio).toBeCloseTo(0.65, 2);
    expect(report.summary.avgCompressionEfficiency).toBeCloseTo(0.35, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/benchmark/report.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement report generator**

```typescript
// src/benchmark/report.ts
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
    `| Metric | Value |`,
    `|--------|-------|`,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/benchmark/report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/benchmark/report.ts tests/benchmark/report.test.ts
git commit -m "feat(benchmark): add report generation and formatting"
```

---

### Task 5: Build CLI entry point

**Files:**
- Create: `src/benchmark/index.ts`

- [ ] **Step 1: Implement the CLI**

```typescript
// src/benchmark/index.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replaySession } from "./session-replay.js";
import { compareTurn } from "./comparison.js";
import { generateReport, formatReport } from "./report.js";
import type { SessionBenchmark } from "./types.js";
import type { ContextEngineConfig } from "../types.js";
import { resolveConfig } from "../config.js";

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
    console.log(`Benchmarking: ${dir.split("/").pop()}`);
    try {
      const benchmark = await benchmarkSession(dir, engineConfig, maxTurns);
      benchmarks.push(benchmark);
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
```

- [ ] **Step 2: Add benchmark script to package.json**

Add to `package.json` scripts:
```json
"benchmark": "bun run src/benchmark/index.ts"
```

- [ ] **Step 3: Commit**

```bash
git add src/benchmark/index.ts package.json
git commit -m "feat(benchmark): add CLI entry point for context engine benchmark"
```

---

### Task 6: Add npm script and verify end-to-end

- [ ] **Step 1: Run the benchmark on existing sessions**

Run: `bun run benchmark`
Expected: Processes all sessions in `~/.praana/sessions/`, outputs comparison report

- [ ] **Step 2: Run with specific session directory**

Run: `bun run benchmark --sessions=/path/to/sessions --max-turns=10`
Expected: Processes up to 10 turns per session

- [ ] **Step 3: Save report to file**

Run: `bun run benchmark --output=benchmark-report.json`
Expected: Saves JSON report alongside console output

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(benchmark): verify end-to-end benchmark execution"
```

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-02-context-engine-benchmark.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
