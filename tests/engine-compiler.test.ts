import { describe, it, expect, setSystemTime } from "bun:test";
import { compileEngineWithMetrics, buildVerbatimSection } from "../src/context-engine/engine-compiler.js";
import { createEmptyCheckpointState } from "../src/context-engine/checkpoint.js";
import { scoreContextUnit } from "../src/context-engine/scoring.js";
import { EmbeddingCache, precomputeVectors } from "../src/context-engine/embedding-cache.js";
import type { ContextEngineConfig } from "../src/types.js";
import type { ContextUnit, SessionCheckpoint, WorkflowPattern, TurnRecord } from "../src/context-engine/types.js";
import type { DomainClassifier } from "../src/domain/types.js";
import type { Embedder } from "../src/memory/types.js";
import type { StateGraph } from "../src/state-graph.js";

const ENGINE_CONFIG: ContextEngineConfig = {
  enabled: true,
  measurement_mode: false,
  artifact_inline_threshold: 400,
  artifact_ttl_turns: 50,
  distiller: { default_intensity: "full" },
  llm_digest: false,
  activity_log_max_entries: 15,
  checkpoint_enabled: true,
  scoring: { w_pin: 1.0, w_recency: 0.5, w_relevance: 0.3, w_semantic: 0.3, w_hydrate_boost: 0.2 },
  pressure: { compact_at: 0.7, emergency_at: 0.85 },
};


function emptyStateGraph(): StateGraph {
  return {
    list: () => [],
    getActive: () => [],
    getPeripheral: () => [],
    snapshot: () => [],
  } as unknown as StateGraph; // test mock — only compiler-used methods are implemented
}

describe("engine compiler", () => {
  it("is deterministic for the same input", async () => {
    const input = {
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "fix failing tests",
      toolSchemas: ["shell(command)"],
      cwd: "/proj",
      sessionId: "sess-1",
      tokenBudget: 100_000,
      checkpointSection: "## Session Checkpoint\n\n### Active Request\nfix tests",
      currentTurn: 5,
      turnRecords: [
        {
          turn: 3,
          userMessage: "run tests",
          assistantMessage: "running npm test",
          toolCalls: [
            {
              tool: "shell",
              args: { command: "npm test" },
              isError: true,
              resultText: "2 failing",
            },
          ],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: ["2 failing"],
          tokenCount: 100,
          timestamp: 1,
        },
        {
          turn: 4,
          userMessage: "fix auth",
          assistantMessage: "patched auth.ts",
          toolCalls: [],
          artifactIds: [],
          filesRead: ["src/auth.ts"],
          filesWritten: ["src/auth.ts"],
          errors: [],
          tokenCount: 80,
          timestamp: 2,
        },
      ],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    };

    setSystemTime(new Date("2025-01-01T12:00:00Z"));
    const a = await compileEngineWithMetrics(input);
    const b = await compileEngineWithMetrics(input);
    expect(a.prompt).toBe(b.prompt);
    setSystemTime(); // reset to real time
    expect(a.scoreRecords).toEqual(b.scoreRecords);
    expect(a.taskType).toBe(b.taskType);
    expect(a.taskType).toBe("debugging");
  });

  it("passes through custom classifier task labels without narrowing", async () => {
    const customClassifier: DomainClassifier = {
      domainId: "prose",
      tieBreakOrder: ["prose"],
      scoreKeywords: () => ({ prose: 3 }),
      scoreTools: () => ({}),
      getBudgetAllocation: () => ({
        errors: 0.10, verbatimTurns: 0.30, decisions: 0.15, artifacts: 0.25, narrative: 0.20,
      }),
    };

    const result = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "edit the essay",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-custom",
      tokenBudget: 100_000,
      currentTurn: 1,
      turnRecords: [],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
      domainClassifier: customClassifier,
    });

    expect(result.taskType).toBe("prose");
    expect(result.taskClassification.taskType).toBe("prose");
  });

  it("includes checkpoint and verbatim recent turns in the prompt", async () => {
    const result = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "continue",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-2",
      tokenBudget: 100_000,
      checkpointSection: "## Session Checkpoint\n\n### Decisions\n- use sqlite",
      currentTurn: 8,
      turnRecords: [
        {
          turn: 5,
          userMessage: "older digest turn",
          assistantMessage: "done",
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 1,
        },
        {
          turn: 7,
          userMessage: "latest",
          assistantMessage: "ok",
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 2,
        },
        {
          turn: 8,
          userMessage: "current",
          assistantMessage: "working",
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 3,
        },
      ],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    });

    expect(result.prompt).toContain("Session Checkpoint");
    expect(result.prompt).toContain("use sqlite");
    expect(result.prompt).toContain("Recent Turns (verbatim)");
    expect(result.prompt).toContain("latest");
    expect(result.scoreRecords.some((r) => r.type === "turn_digest")).toBe(true);
  });

  it("excludes current user input from the system prompt (lives in messages)", async () => {
    const result = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "unique-current-request-xyz",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-no-dup",
      tokenBudget: 100_000,
      currentTurn: 1,
      turnRecords: [],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    });

    expect(result.prompt).not.toContain("## Current Input");
    expect(result.prompt).not.toContain("unique-current-request-xyz");
    expect(result.metrics.currentInputTokens).toBe(0);
  });

  it("scores pinned units higher than stale low-relevance units", () => {
    const unit: ContextUnit = {
      id: "turn_3",
      type: "turn_digest",
      content: "fix failing auth tests in src/auth.ts",
      tokens: 50,
      sourceTurn: 3,
      score: 0,
      pinned: false,
      artifactRefs: [],
    };
    const pinned: ContextUnit = { ...unit, id: "pinned", pinned: true };
    const recent = scoreContextUnit(unit, 5, "fix failing tests", ENGINE_CONFIG.scoring);
    const pinnedScore = scoreContextUnit(pinned, 5, "fix failing tests", ENGINE_CONFIG.scoring);
    expect(pinnedScore.score).toBeGreaterThan(recent.score);
  });

  it("hydrate_boost increases score when unit content overlaps hydrated object text", () => {
    const unit: ContextUnit = {
      id: "turn_5",
      type: "turn_digest",
      content: "Updated the login authentication handler to fix the 401 error",
      tokens: 50,
      sourceTurn: 5,
      score: 0,
      pinned: false,
      artifactRefs: [],
    };
    const weights = ENGINE_CONFIG.scoring; // w_hydrate_boost: 0.2
    const baseResult = scoreContextUnit(unit, 10, "auth bug", weights);
    const boostedResult = scoreContextUnit(unit, 10, "auth bug", weights, [
      "Fix authentication bug — Login endpoint returns 401",
    ]);
    expect(boostedResult.score).toBeGreaterThan(baseResult.score);
    expect(boostedResult.breakdown.hydrate_boost).toBeGreaterThan(0);
  });

  it("hydrate_boost is zero when hydratedTexts is empty or w_hydrate_boost is 0", () => {
    const unit: ContextUnit = {
      id: "turn_6",
      type: "turn_digest",
      content: "login auth handler",
      tokens: 30,
      sourceTurn: 6,
      score: 0,
      pinned: false,
      artifactRefs: [],
    };
    const weightsNoBoost = { ...ENGINE_CONFIG.scoring, w_hydrate_boost: 0 };
    const r1 = scoreContextUnit(unit, 10, "auth", weightsNoBoost, ["login auth handler"]);
    expect(r1.breakdown.hydrate_boost).toBe(0);

    const r2 = scoreContextUnit(unit, 10, "auth", ENGINE_CONFIG.scoring, []);
    expect(r2.breakdown.hydrate_boost).toBe(0);
  });

  it("uses semantic similarity when vectors are available", () => {
    const unit: ContextUnit = {
      id: "turn_semantic",
      type: "turn_digest",
      content: "auth middleware handler",
      tokens: 30,
      sourceTurn: 6,
      score: 0,
      pinned: false,
      artifactRefs: [],
    };
    const withSemanticWeights = {
      ...ENGINE_CONFIG.scoring,
      w_semantic: 0.3,
    } as ContextEngineConfig["scoring"] & { w_semantic: number };

    const baseline = scoreContextUnit(
      unit,
      10,
      "authentication handler",
      withSemanticWeights,
    );

    // userInput and unit.content vectors are identical to force max similarity.
    const vectors = new Map<string, Float32Array>([
      ["authentication handler", new Float32Array([1, 0, 0])],
      ["auth middleware handler", new Float32Array([1, 0, 0])],
    ]);

    const semantic = scoreContextUnit(
      unit,
      10,
      "authentication handler",
      withSemanticWeights,
      undefined,
      vectors,
    );

    expect(semantic.breakdown.semantic).toBeGreaterThan(0);
    expect(semantic.score).toBeGreaterThan(baseline.score);
    expect(semantic.breakdown.relevance).toBe(
      Math.max(semantic.breakdown.bm25, semantic.breakdown.semantic),
    );
  });

  it("keeps BM25 as relevance when keyword match beats semantic similarity", () => {
    const unit: ContextUnit = {
      id: "turn_keyword",
      type: "turn_digest",
      content: "read_file path src/auth.ts",
      tokens: 30,
      sourceTurn: 6,
      score: 0,
      pinned: false,
      artifactRefs: [],
    };
    const weights = { ...ENGINE_CONFIG.scoring, w_semantic: 0.3 };
    const vectors = new Map<string, Float32Array>([
      ["read_file src/auth.ts", new Float32Array([0, 1, 0])],
      ["read_file path src/auth.ts", new Float32Array([1, 0, 0])],
    ]);

    const scored = scoreContextUnit(
      unit,
      10,
      "read_file src/auth.ts",
      weights,
      undefined,
      vectors,
    );

    expect(scored.breakdown.bm25).toBeGreaterThan(scored.breakdown.semantic);
    expect(scored.breakdown.relevance).toBe(scored.breakdown.bm25);
  });

  it("applies semantic scoring through compileEngineWithMetrics when embedder is provided", async () => {
    const embedder: Embedder = {
      dim: 3,
      embed: async (text: string) => {
        if (text.trim() === "authentication handler") return new Float32Array([1, 0, 0]);
        if (text.trim().includes("auth middleware")) return new Float32Array([1, 0, 0]);
        return new Float32Array([0, 0, 1]);
      },
    };
    const cache = new EmbeddingCache();

    const result = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "authentication handler",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-semantic",
      tokenBudget: 100_000,
      checkpointSection: "",
      currentTurn: 10,
      turnRecords: [
        {
          turn: 5,
          userMessage: "fix auth middleware",
          assistantMessage: "updated auth middleware handler",
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 50,
          timestamp: 1,
        },
      ],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
      embedder,
      embeddingCache: cache,
    });

    const digestRecord = result.scoreRecords.find((r) => r.unitId === "turn_5");
    expect(digestRecord).toBeDefined();
    expect(digestRecord!.breakdown.semantic).toBeGreaterThan(0);
    expect(digestRecord!.breakdown.relevance).toBe(
      Math.max(digestRecord!.breakdown.bm25, digestRecord!.breakdown.semantic),
    );
  });

  it("precomputeVectors with cached embeddings completes scoring within budget", async () => {
    const embedder: Embedder = {
      dim: 8,
      embed: async () => new Float32Array(8).fill(0.5),
    };
    const cache = new EmbeddingCache();
    const texts = Array.from({ length: 40 }, (_, i) => `context unit text ${i}`);

    const start = performance.now();
    await precomputeVectors(texts, embedder, cache);
    await precomputeVectors(texts, embedder, cache);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
  });

  it("hydratedTexts flow through compileEngineWithMetrics to scoring", async () => {
    // Turn age must be in [3, 6] to be emitted as a scored digest unit.
    // With currentTurn=10, turn=5 gives age=5 — within the scored window.
    const baseResult = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "auth issue",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-3",
      tokenBudget: 100_000,
      checkpointSection: "",
      currentTurn: 10,
      turnRecords: [{ turn: 5, userMessage: "fix auth", assistantMessage: "fixed authentication login endpoint returning 401 error", toolCalls: [], artifactIds: [], filesRead: [], filesWritten: [], errors: [], tokenCount: 50, timestamp: 1 }],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    });
    const boostedResult = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "auth issue",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-4",
      tokenBudget: 100_000,
      checkpointSection: "",
      currentTurn: 10,
      turnRecords: [{ turn: 5, userMessage: "fix auth", assistantMessage: "fixed authentication login endpoint returning 401 error", toolCalls: [], artifactIds: [], filesRead: [], filesWritten: [], errors: [], tokenCount: 50, timestamp: 1 }],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
      hydratedTexts: ["Fix authentication login bug — endpoint returning 401"],
    });
    const basePick = baseResult.scoreRecords.find((r) => r.unitId.includes("turn"));
    const boostedPick = boostedResult.scoreRecords.find((r) => r.unitId.includes("turn"));
    expect(basePick).toBeDefined();
    expect(boostedPick).toBeDefined();
    expect(boostedPick!.breakdown.hydrate_boost).toBeGreaterThan(0);
    expect(boostedPick!.score).toBeGreaterThan(basePick!.score);
  });

  it("uses weighted pressure lower than raw token ratio for finding-heavy checkpoint", async () => {
    const state = createEmptyCheckpointState();
    state.decisions = [
      { summary: "use sqlite", rationale: "local", turn: 2, compact: false },
    ];
    state.findings = Array.from({ length: 30 }, (_, i) => ({
      summary: `Verbose error trace and artifact dump ${i} `.repeat(30),
      artifactRef: `art-${i}`,
      turn: i,
    }));
    state.activity = Array.from({ length: 15 }, (_, i) => ({
      turn: i,
      type: "tool_call" as const,
      summary: `shell npm test iteration ${i}`,
    }));

    const checkpoint: SessionCheckpoint = { version: 1, state };
    const smallWindow = 8_000;

    const result = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "continue",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-density",
      tokenBudget: smallWindow,
      contextWindowTokens: smallWindow,
      checkpoint,
      currentTurn: 10,
      turnRecords: [],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    });

    const rawRatio = result.metrics.totalTokens / smallWindow;
    expect(result.weightedTokens).toBeLessThan(result.metrics.totalTokens);
    expect(result.pressureRatio).toBeLessThan(rawRatio);
  });

  it("emergency checkpoint in prompt omits findings when pressure is high", async () => {
    const state = createEmptyCheckpointState();
    state.decisions = [
      { summary: "keep this decision", rationale: "important", turn: 1, compact: false },
    ];
    state.findings = Array.from({ length: 30 }, (_, i) => ({
      summary: `Low value finding ${i} `.repeat(40),
      turn: i,
    }));

    const checkpoint: SessionCheckpoint = { version: 1, state };
    const tinyWindow = 2_000;

    const result = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "continue",
      agentsContext: "AGENTS ".repeat(4000),
      toolSchemas: ["shell(command)"],
      cwd: "/proj",
      sessionId: "sess-emergency",
      tokenBudget: tinyWindow,
      contextWindowTokens: tinyWindow,
      checkpoint,
      currentTurn: 5,
      turnRecords: [
        {
          turn: 4,
          userMessage: "run",
          assistantMessage: "ok ".repeat(400),
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 1,
        },
        {
          turn: 5,
          userMessage: "again",
          assistantMessage: "done ".repeat(400),
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 2,
        },
      ],
      activityEntries: [],
      engineConfig: {
        ...ENGINE_CONFIG,
        pressure: { compact_at: 0.5, emergency_at: 0.7 },
      },
    });

    expect(result.pressureMode).toBe("emergency");
    expect(result.prompt).toContain("keep this decision");
    expect(result.prompt).not.toContain("### Findings");
  });

  it("does not double-count agentsContext in weighted pressure", async () => {
    const largeAgents = "AGENTS ".repeat(4000);
    const base = {
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "continue",
      toolSchemas: ["shell(command)"],
      cwd: "/proj",
      sessionId: "sess-agents-dc",
      tokenBudget: 100_000,
      contextWindowTokens: 100_000,
      checkpointSection: "",
      currentTurn: 2,
      turnRecords: [],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
    };

    const withoutAgents = await compileEngineWithMetrics({ ...base, agentsContext: "" });
    const withAgents = await compileEngineWithMetrics({ ...base, agentsContext: largeAgents });
    const agentsTokens = withAgents.metrics.agentsContextTokens;
    expect(agentsTokens).toBeGreaterThan(1000);

    const delta = withAgents.weightedTokens - withoutAgents.weightedTokens;
    expect(delta).toBeGreaterThan(agentsTokens * 0.7);
    expect(delta).toBeLessThan(agentsTokens * 1.3);
  });

  it("reports compact pressure mode when checkpoint renders in compact mode", async () => {
    const state = createEmptyCheckpointState();
    state.decisions = [
      { summary: "keep compact decision", rationale: "important", turn: 1, compact: false },
    ];
    state.findings = Array.from({ length: 30 }, (_, i) => ({
      summary: `Finding ${i} `.repeat(30),
      turn: i,
    }));
    state.activity = Array.from({ length: 12 }, (_, i) => ({
      turn: i,
      type: "tool_call" as const,
      summary: `activity-${i}`,
    }));

    const checkpoint: SessionCheckpoint = { version: 1, state };
    const window = 2_500;

    const result = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "x".repeat(1000),
      toolSchemas: ["shell(command)"],
      cwd: "/proj",
      sessionId: "sess-pressure-mode",
      tokenBudget: window,
      contextWindowTokens: window,
      checkpoint,
      currentTurn: 5,
      turnRecords: [],
      activityEntries: [],
      engineConfig: {
        ...ENGINE_CONFIG,
        pressure: { compact_at: 0.3, emergency_at: 0.85 },
      },
    });

    expect(result.pressureMode).toBe("compact");
    expect(result.prompt).toContain("keep compact decision");
    expect(result.prompt).toContain("activity-11");
    expect(result.prompt).not.toContain("activity-0");
  });

  it("forces emergency when raw tokens exceed usable budget despite low weighted pressure", async () => {
    const state = createEmptyCheckpointState();
    state.findings = Array.from({ length: 30 }, (_, i) => ({
      summary: `Verbose low-value trace ${i} `.repeat(50),
      turn: i,
    }));

    const checkpoint: SessionCheckpoint = { version: 1, state };
    const tinyWindow = 1_500;

    const result = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "continue",
      agentsContext: "AGENTS ".repeat(4000),
      toolSchemas: ["shell(command)"],
      cwd: "/proj",
      sessionId: "sess-raw-safety",
      tokenBudget: tinyWindow,
      contextWindowTokens: tinyWindow,
      checkpoint,
      currentTurn: 3,
      turnRecords: [
        {
          turn: 2,
          userMessage: "run",
          assistantMessage: "ok ".repeat(400),
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 1,
        },
        {
          turn: 3,
          userMessage: "again",
          assistantMessage: "done ".repeat(400),
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 2,
        },
      ],
      activityEntries: [],
      engineConfig: {
        ...ENGINE_CONFIG,
        pressure: { compact_at: 0.95, emergency_at: 0.99 },
      },
    });

    expect(result.metrics.totalTokens).toBeGreaterThan(tinyWindow * 0.5);
    expect(result.rawPressureRatio).toBeGreaterThan(1);
    expect(result.pressureMode).toBe("emergency");
    expect(result.prompt).not.toContain("### Findings");
  });

  it("budgetAllocation in result reflects the classified task type", async () => {
    const debugClassifier: DomainClassifier = {
      domainId: "test",
      tieBreakOrder: [],
      scoreKeywords: () => ({ debugging: 5 }),
      scoreTools: () => ({}),
      getBudgetAllocation: (t) => t === "debugging"
        ? { errors: 0.25, verbatimTurns: 0.35, decisions: 0.10, artifacts: 0.20, narrative: 0.10 }
        : { errors: 0.10, verbatimTurns: 0.30, decisions: 0.15, artifacts: 0.25, narrative: 0.20 },
    };

    const result = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "fix the bug",
      toolSchemas: [],
      cwd: "/tmp",
      sessionId: "s1",
      tokenBudget: 20000,
      currentTurn: 0,
      turnRecords: [],
      engineConfig: ENGINE_CONFIG,
      domainClassifier: debugClassifier,
    });

    expect(result.taskType).toBe("debugging");
    expect(result.budgetAllocation).toEqual({
      errors: 0.25, verbatimTurns: 0.35, decisions: 0.10, artifacts: 0.20, narrative: 0.10,
    });
  });


  it("weighted tokens reflect task-type-aware checkpoint budgets", async () => {
    // Build a checkpoint whose narrative section would dominate the default budget.
    const state = createEmptyCheckpointState();
    state.narrative = Array.from({ length: 30 }, (_, i) => ({
      turn: i,
      text: `Long narrative entry number ${i} with enough text to consume tokens `.repeat(5),
    }));
    state.activeRequest = "debug the auth bug";

    const checkpoint: SessionCheckpoint = { version: 1, state };
    const window = 8_000;

    const defaultAlloc = {
      errors: 0.10,
      verbatimTurns: 0.30,
      decisions: 0.15,
      artifacts: 0.25,
      narrative: 0.20,
    };

    const makeClassifier = (narrativeShare: number): DomainClassifier => ({
      domainId: "test",
      tieBreakOrder: [],
      scoreKeywords: () => ({ debugging: 5 }),
      scoreTools: () => ({}),
      getBudgetAllocation: (taskType: string) =>
        taskType === "debugging"
          ? {
              errors: 0.10,
              verbatimTurns: 0.30,
              decisions: 0.10,
              artifacts: Number((0.50 - narrativeShare).toFixed(2)),
              narrative: narrativeShare,
            }
          : { ...defaultAlloc },
    });

    const largeNarrative = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "fix the bug",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-narrative-large",
      tokenBudget: window,
      contextWindowTokens: window,
      checkpoint,
      currentTurn: 10,
      turnRecords: [],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
      domainClassifier: makeClassifier(0.40),
    });

    const smallNarrative = await compileEngineWithMetrics({
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "fix the bug",
      toolSchemas: [],
      cwd: "/proj",
      sessionId: "sess-narrative-small",
      tokenBudget: window,
      contextWindowTokens: window,
      checkpoint,
      currentTurn: 10,
      turnRecords: [],
      activityEntries: [],
      engineConfig: ENGINE_CONFIG,
      domainClassifier: makeClassifier(0.05),
    });

    // A smaller narrative allocation should yield a lower checkpoint effective
    // token count and therefore lower weighted pressure.
    expect(smallNarrative.weightedTokens).toBeLessThan(largeNarrative.weightedTokens);
    expect(smallNarrative.metrics.checkpointTokens).toBeLessThan(
      largeNarrative.metrics.checkpointTokens,
    );
    // Both should still classify as debugging and render some checkpoint.
    expect(smallNarrative.prompt).toContain("Session Checkpoint");
    expect(largeNarrative.prompt).toContain("Session Checkpoint");
  });
  it("scored band caps differ between debugging and testing task types", async () => {
    const makeClassifier = (taskType: string): DomainClassifier => ({
      domainId: "test",
      tieBreakOrder: [],
      scoreKeywords: () => ({ [taskType]: 5 }),
      scoreTools: () => ({}),
      getBudgetAllocation: (t: string) => t === "testing"
        ? { errors: 0.10, verbatimTurns: 0.25, decisions: 0.15, artifacts: 0.35, narrative: 0.15 }
        : { errors: 0.10, verbatimTurns: 0.30, decisions: 0.15, artifacts: 0.25, narrative: 0.20 },
    });

    const baseInput = {
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "run tests",
      toolSchemas: [],
      cwd: "/tmp",
      sessionId: "s1",
      tokenBudget: 20000,
      currentTurn: 10,
      turnRecords: [
        {
          turn: 6,
          userMessage: "do work",
          assistantMessage: "done",
          toolCalls: Array.from({ length: 20 }, (_, i) => ({
            tool: "run",
            args: { command: `echo a${i}` },
            resultArtifactId: `art_${i}`,
            resultText: "Y".repeat(800),
          })),
          artifactIds: Array.from({ length: 20 }, (_, i) => `art_${i}`),
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 100,
          timestamp: 1,
        },
      ],
      engineConfig: ENGINE_CONFIG,
    };

    const testingResult = await compileEngineWithMetrics({
      ...baseInput,
      domainClassifier: makeClassifier("testing"),
    });
    const generalResult = await compileEngineWithMetrics({
      ...baseInput,
      domainClassifier: makeClassifier("general"),
    });

    expect(testingResult.budgetAllocation.artifacts).toBeGreaterThan(
      generalResult.budgetAllocation.artifacts,
    );
    // Verify scaled band caps actually affect the prompt composition by
    // checking inclusion counts in scoreRecords.  testing artifacts=0.35
    // gives a larger band cap (1.4× general), so more scored units should
    // be included from the artifact-heavy turn record.
    const testingIncluded = testingResult.scoreRecords.filter(
      (r) => r.included,
    ).length;
    const generalIncluded = generalResult.scoreRecords.filter(
      (r) => r.included,
    ).length;
    expect(testingIncluded).toBeGreaterThanOrEqual(generalIncluded);
    // With stub artifact cards the token difference may be zero, but the
    // budget allocation still controls which scored units are included.
    // Verify that the testing allocation (artifacts=0.35) includes at least
    // as many artifact records as the general allocation (artifacts=0.25).
    const testingArtifacts = testingResult.scoreRecords.filter(
      (r) => r.included && r.type === "artifact_card",
    ).length;
    const generalArtifacts = generalResult.scoreRecords.filter(
      (r) => r.included && r.type === "artifact_card",
    ).length;
    expect(testingArtifacts).toBeGreaterThanOrEqual(generalArtifacts);
  });

  it("scored artifact stub cards show the artifact store's raw token count", async () => {
    const input = {
      stateGraph: emptyStateGraph(),
      memoryDigest: null,
      recentEvents: [],
      userInput: "check the search results",
      toolSchemas: [],
      cwd: "/tmp",
      sessionId: "s1",
      tokenBudget: 20000,
      currentTurn: 10,
      turnRecords: [
        {
          turn: 5,
          userMessage: "find foo",
          assistantMessage: "searching",
          toolCalls: [
            {
              tool: "search_code",
              args: { path: "src/" },
              resultArtifactId: "art_big1234567",
              // Ledger text is truncated (~400 chars); it must not drive the
              // "N tokens raw" label when a store resolver is available.
              resultText: "Y".repeat(800),
            },
          ],
          artifactIds: ["art_big1234567"],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 100,
          timestamp: 1,
        },
      ],
      engineConfig: ENGINE_CONFIG,
    };

    const withResolver = await compileEngineWithMetrics({
      ...input,
      artifactTokens: (id: string) => (id === "art_big1234567" ? 42_100 : undefined),
    });
    expect(withResolver.prompt).toContain("42,100 tokens raw");
    expect(withResolver.prompt).toContain('retrieve_artifact("art_big1234567")');

    // Without a resolver, fall back to the ledger-text estimate.
    const withoutResolver = await compileEngineWithMetrics(input);
    expect(withoutResolver.prompt).toContain('retrieve_artifact("art_big1234567")');
    expect(withoutResolver.prompt).not.toContain("42,100 tokens raw");
  });
});

// ---------------------------------------------------------------------------
// Workflow context injection (issue #92)
// ---------------------------------------------------------------------------

describe("engine compiler — workflow context injection", () => {
  // Force a specific task type so tests are independent of keyword matching.
  const makeClassifier = (taskType: string): DomainClassifier => ({
    domainId: "test",
    tieBreakOrder: [],
    scoreKeywords: () => ({ [taskType]: 5 }),
    scoreTools: () => ({}),
    getBudgetAllocation: () => ({
      errors: 0.10, verbatimTurns: 0.30, decisions: 0.15, artifacts: 0.25, narrative: 0.20,
    }),
  });

  const BASE_INPUT = {
    stateGraph: emptyStateGraph(),
    memoryDigest: null,
    recentEvents: [],
    userInput: "run the tests",
    toolSchemas: ["shell(command)"],
    cwd: "/proj",
    sessionId: "sess-wf",
    tokenBudget: 100_000,
    currentTurn: 2,
    turnRecords: [],
    activityEntries: [],
    engineConfig: ENGINE_CONFIG,
    domainClassifier: makeClassifier("testing"),
  };

  function makePattern(taskType: string, overrides: Partial<WorkflowPattern> = {}): WorkflowPattern {
    return {
      id: `${taskType}-abc`,
      taskType,
      toolSequence: ["read_file", "shell"],
      artifactTypes: ["test_output"],
      hitCount: 3,
      lastSeen: Date.now(),
      createdAt: Date.now(),
      ...overrides,
    };
  }

  it("injects workflow context section when patterns match the classified task type", async () => {
    const result = await compileEngineWithMetrics({
      ...BASE_INPUT,
      workflowPatterns: [makePattern("testing")],
    });
    expect(result.prompt).toContain("## Workflow Context");
    expect(result.prompt).toContain("testing");
    expect(result.prompt).toContain("read_file");
    expect(result.prompt).toContain("shell");
    expect(result.metrics.workflowContextTokens).toBeGreaterThan(0);
  });

  it("does not inject workflow context when no patterns are provided", async () => {
    const result = await compileEngineWithMetrics({
      ...BASE_INPUT,
      workflowPatterns: [],
    });
    expect(result.prompt).not.toContain("## Workflow Context");
    expect(result.metrics.workflowContextTokens).toBe(0);
  });

  it("filters out patterns whose task type does not match the classified type", async () => {
    // Classifier says 'testing'; debugging patterns should be dropped.
    const result = await compileEngineWithMetrics({
      ...BASE_INPUT,
      workflowPatterns: [
        makePattern("debugging", { toolSequence: ["shell", "write_file"] }),
      ],
    });
    expect(result.prompt).not.toContain("## Workflow Context");
    expect(result.metrics.workflowContextTokens).toBe(0);
  });

  it("filters correctly when a mix of matching and non-matching patterns are supplied", async () => {
    const result = await compileEngineWithMetrics({
      ...BASE_INPUT,
      workflowPatterns: [
        makePattern("testing", { toolSequence: ["read_file", "shell"], artifactTypes: ["test_output"] }),
        makePattern("debugging", { toolSequence: ["shell", "write_file"] }),
      ],
    });
    expect(result.prompt).toContain("## Workflow Context");
    // testing-specific tool should be present
    expect(result.prompt).toContain("read_file");
    // debugging-specific tool injected only via debugging pattern — must not appear
    // unless it also appears in the testing pattern (it doesn't)
    const workflowSection = result.prompt
      .split("\n")
      .filter((l) => l.includes("Workflow") || l.includes("Tools typically") || l.includes("Artifact"))
      .join("\n");
    expect(workflowSection).not.toContain("write_file");
  });

  it("workflowContextTokens are included in pressure-weighted token count", async () => {
    // With patterns: prompt + workflow section
    const withPatterns = await compileEngineWithMetrics({
      ...BASE_INPUT,
      workflowPatterns: [makePattern("testing", { hitCount: 10 })],
    });
    // Without patterns: prompt only
    const withoutPatterns = await compileEngineWithMetrics({
      ...BASE_INPUT,
      workflowPatterns: [],
    });
    // The weighted token count should be higher when workflow section is injected.
    expect(withPatterns.weightedTokens).toBeGreaterThan(withoutPatterns.weightedTokens);
    expect(withPatterns.metrics.totalTokens).toBeGreaterThan(withoutPatterns.metrics.totalTokens);
  });

  it("filters workflow patterns even during raw-safety emergency recompilation", async () => {
    const state = createEmptyCheckpointState();
    state.findings = Array.from({ length: 30 }, (_, i) => ({
      summary: `Verbose low-value trace ${i} `.repeat(50),
      turn: i,
    }));
    const checkpoint: SessionCheckpoint = { version: 1, state };
    const tinyWindow = 1_500;

    const result = await compileEngineWithMetrics({
      ...BASE_INPUT,
      tokenBudget: tinyWindow,
      contextWindowTokens: tinyWindow,
      userInput: "run the tests",
      agentsContext: "AGENTS ".repeat(4000),
      checkpoint,
      currentTurn: 3,
      turnRecords: [
        {
          turn: 2,
          userMessage: "run",
          assistantMessage: "ok ".repeat(400),
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 1,
        },
        {
          turn: 3,
          userMessage: "again",
          assistantMessage: "done ".repeat(400),
          toolCalls: [],
          artifactIds: [],
          filesRead: [],
          filesWritten: [],
          errors: [],
          tokenCount: 10,
          timestamp: 2,
        },
      ],
      engineConfig: {
        ...ENGINE_CONFIG,
        pressure: { compact_at: 0.95, emergency_at: 0.99 },
      },
      workflowPatterns: [
        makePattern("testing", { toolSequence: ["read_file", "shell"] }),
        makePattern("debugging", { toolSequence: ["shell", "write_file"] }),
      ],
    });

    expect(result.pressureMode).toBe("emergency");
    expect(result.rawPressureRatio).toBeGreaterThan(1);
    const workflowSection = result.prompt
      .split("\n")
      .filter((l) => l.includes("Workflow") || l.includes("Tools typically") || l.includes("Artifact"))
      .join("\n");
    expect(workflowSection).toContain("## Workflow Context");
    expect(workflowSection).toContain("read_file");
    expect(workflowSection).not.toContain("write_file");
  });

  it("injects agent hints when repeat_file_reads crosses threshold", async () => {
    const result = await compileEngineWithMetrics({
      ...BASE_INPUT,
      agentHints: "## Agent Hints\n\n- repeat_file_reads: 6 — before re-reading a path, use retrieve_artifact or search_turn_events.",
    });
    expect(result.prompt).toContain("## Agent Hints");
    expect(result.prompt).toContain("repeat_file_reads: 6");
    expect(result.metrics.agentHintsTokens).toBeGreaterThan(0);
  });

  it("does not inject agent hints when the section is empty", async () => {
    const result = await compileEngineWithMetrics({
      ...BASE_INPUT,
      agentHints: "",
    });
    expect(result.prompt).not.toContain("## Agent Hints");
    expect(result.metrics.agentHintsTokens).toBe(0);
  });

  it("includes agent hints tokens in pressure-weighted count", async () => {
    const withHints = await compileEngineWithMetrics({
      ...BASE_INPUT,
      agentHints: "## Agent Hints\n\n- repeat_file_reads: 6 — before re-reading a path, use retrieve_artifact or search_turn_events.",
    });
    const withoutHints = await compileEngineWithMetrics({
      ...BASE_INPUT,
      agentHints: "",
    });
    expect(withHints.weightedTokens).toBeGreaterThan(withoutHints.weightedTokens);
    expect(withHints.metrics.agentHintsTokens ?? 0).toBeGreaterThan(0);
    expect(withoutHints.metrics.agentHintsTokens ?? 0).toBe(0);
  });

  it("injects files read index section when non-empty", async () => {
    const result = await compileEngineWithMetrics({
      ...BASE_INPUT,
      filesReadIndex: "## Files Read This Session\n\n- src/auth.ts (turn 3, `art_abc123`)",
    });
    expect(result.prompt).toContain("## Files Read This Session");
    expect(result.prompt).toContain("- src/auth.ts (turn 3, `art_abc123`)");
    expect(result.metrics.filesReadIndexTokens).toBeGreaterThan(0);
  });

  it("does not inject files read index when the section is empty", async () => {
    const result = await compileEngineWithMetrics({
      ...BASE_INPUT,
      filesReadIndex: "",
    });
    expect(result.prompt).not.toContain("## Files Read This Session");
    expect(result.metrics.filesReadIndexTokens).toBe(0);
  });

  it("includes files read index tokens in pressure-weighted count", async () => {
    const withIndex = await compileEngineWithMetrics({
      ...BASE_INPUT,
      filesReadIndex: "## Files Read This Session\n\n- src/auth.ts (turn 3, `art_abc123`)",
    });
    const withoutIndex = await compileEngineWithMetrics({
      ...BASE_INPUT,
      filesReadIndex: "",
    });
    expect(withIndex.weightedTokens).toBeGreaterThan(withoutIndex.weightedTokens);
    expect(withIndex.metrics.filesReadIndexTokens ?? 0).toBeGreaterThan(0);
    expect(withoutIndex.metrics.filesReadIndexTokens ?? 0).toBe(0);
  });
});

describe("buildVerbatimSection progressive trimming", () => {
  function makeRecord(turn: number, text: string): TurnRecord {
    return {
      turn,
      userMessage: text,
      assistantMessage: "ok",
      toolCalls: [],
      artifactIds: [],
      filesRead: [],
      filesWritten: [],
      errors: [],
      tokenCount: 10,
      timestamp: turn,
    };
  }

  it("keeps all 3 recent turns when they fit", () => {
    const records = [
      makeRecord(1, "a".repeat(200)),
      makeRecord(2, "b".repeat(200)),
      makeRecord(3, "c".repeat(200)),
    ];
    const result = buildVerbatimSection(records, 3, 3000);
    expect(result.text).toContain("Turn 1");
    expect(result.text).toContain("Turn 2");
    expect(result.text).toContain("Turn 3");
    expect(result.truncated).toBe(false);
  });

  it("drops the oldest turn when 3 turns exceed the cap but 2 fit", () => {
    const records = [
      makeRecord(1, "a".repeat(5000)),
      makeRecord(2, "b".repeat(5000)),
      makeRecord(3, "c".repeat(5000)),
    ];
    const result = buildVerbatimSection(records, 3, 3000);
    expect(result.text).not.toContain("Turn 1");
    expect(result.text).toContain("Turn 2");
    expect(result.text).toContain("Turn 3");
    expect(result.truncated).toBe(true);
  });

  it("keeps only the current turn when 2 turns do not fit", () => {
    const records = [
      makeRecord(2, "b".repeat(8000)),
      makeRecord(3, "c".repeat(8000)),
    ];
    const result = buildVerbatimSection(records, 3, 3000);
    expect(result.text).not.toContain("Turn 2");
    expect(result.text).toContain("Turn 3");
    expect(result.truncated).toBe(true);
  });

  it("truncates a single oversized turn from the front", () => {
    const records = [makeRecord(3, "c".repeat(10_000))];
    const result = buildVerbatimSection(records, 3, 500);
    expect(result.text).toContain("Turn 3");
    expect(result.text).toContain("...truncated...");
    expect(result.truncated).toBe(true);
  });
});
