import type { ContextEngineConfig } from "../types.js";
import type { Event } from "../types.js";
import type { TurnComparison, CompilationSnapshot } from "./types.js";
import type { ReplayTurn } from "./session-replay.js";
import { compileClassicWithMetrics } from "../compile-classic.js";
import { compileEngineWithMetrics, type EngineCompileInput } from "../context-engine/engine-compiler.js";
import { createEmptyCheckpointState } from "../context-engine/checkpoint.js";
import type { SessionCheckpoint } from "../context-engine/types.js";
import { StateGraph } from "../state-graph.js";

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

  const stateGraph = new StateGraph();

  const checkpoint: SessionCheckpoint = {
    version: 1,
    state: createEmptyCheckpointState(),
  };

  const engineInput: EngineCompileInput = {
    cwd,
    sessionId,
    toolSchemas: [],
    stateGraph,
    recentEvents: events,
    memoryDigest: null,
    userInput: turns[currentTurn - 1]?.userMessage,
    currentTurn: currentTurn - 1,
    turnRecords,
    engineConfig,
    checkpoint,
    tokenBudget: 128_000,
    contextWindowTokens: 200_000,
  };

  const engineResult = await compileEngineWithMetrics(engineInput);

  const includedUnits = engineResult.scoreRecords
    .filter((r) => r.included)
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
    }));
  const excludedUnits = engineResult.scoreRecords
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
    }));

  const engineSnapshot: CompilationSnapshot = {
    totalTokens: engineResult.metrics.totalTokens,
    metrics: engineResult.metrics,
    scoredUnits: {
      included: includedUnits,
      excluded: excludedUnits,
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
    events.push({
      event_id: `bench-${turn.turnNumber}-user`,
      session_id: "benchmark",
      kind: "user_message",
      actor: "user",
      payload: { text: turn.userMessage },
      timestamp: turn.turnNumber,
    });
    for (const tc of turn.toolCalls) {
      events.push({
        event_id: `bench-${turn.turnNumber}-tool-${tc.tool}`,
        session_id: "benchmark",
        kind: "tool_call",
        actor: "agent",
        payload: { tool: tc.tool, args: tc.args },
        timestamp: turn.turnNumber,
      });
      if (tc.resultText) {
        events.push({
          event_id: `bench-${turn.turnNumber}-result-${tc.tool}`,
          session_id: "benchmark",
          kind: "tool_result",
          actor: "agent",
          payload: { tool: tc.tool, result: tc.resultText },
          timestamp: turn.turnNumber,
        });
      }
    }
    if (turn.assistantMessage) {
      events.push({
        event_id: `bench-${turn.turnNumber}-agent`,
        session_id: "benchmark",
        kind: "agent_message",
        actor: "agent",
        payload: { text: turn.assistantMessage },
        timestamp: turn.turnNumber,
      });
    }
  }
  return events;
}
