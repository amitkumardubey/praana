import type {
  CompileInput,
  CompileMetrics,
} from "../compiler.js";
import {
  buildActiveState,
  buildCrossSessionMemory,
  buildPeripheralStubs,
  buildSystemFrame,
  buildStateSummary,
  trimAgentsContext,
  trimSectionToTokenBudget,
} from "../compiler.js";
import {
  estimateCheckpointEffectiveTokens,
  renderCheckpoint,
  NARRATIVE_RENDER_TOKENS,
  DECISIONS_SECTION_TOKENS,
  ERRORS_SECTION_TOKENS,
} from "./checkpoint.js";
import type { CheckpointSectionBudgets } from "./checkpoint.js";
import { effectiveTokens } from "./density.js";
import type { SectionDensityKind } from "./density.js";
import { buildArtifactCard } from "./summarize.js";
import { getAppLogger } from "../logger.js";
import { estimateTokens } from "./summarize.js";
import {
  rankContextUnits,
  recencyScore,
  scoreContextUnit,
  selectUnitsWithinBudget,
  unitTokens,
} from "./scoring.js";
import type { Embedder } from "../memory/types.js";
import { EmbeddingCache, precomputeVectors } from "./embedding-cache.js";
import type {
  ActivityEntry,
  CompileScoreRecord,
  ContextUnit,
  ContextUnitType,
  PressureMode,
  ScoreBreakdown,
  SessionCheckpoint,
  TurnRecord,
  WorkflowPattern,
} from "./types.js";
import type { ContextEngineConfig } from "../types.js";
import { classifyTask, getDefaultDomainClassifier } from "../domain/task-classify.js";
import { validateBudgetAllocation } from "../domain/types.js";
import type { BudgetAllocation, DomainClassifier, TaskClassificationResult } from "../domain/types.js";
import { renderWorkflowContext } from "./workflow-tracker.js";

const BAND_VERBATIM_TOKENS = 3000;
const BAND_SCORED_RECENT_TOKENS = 3000;
const BAND_SCORED_OLDER_TOKENS = 2000;

export interface EngineCompileInput extends CompileInput {
  currentTurn: number;
  turnRecords: TurnRecord[];
  activityEntries?: ActivityEntry[];
  engineConfig: ContextEngineConfig;
  /** Model input context window; pressure is measured against this when set. */
  contextWindowTokens?: number;
  /** Searchable texts of auto-hydrated peripheral objects; used for scoring boost. */
  hydratedTexts?: string[];
  /** Structured checkpoint for pressure-aware rendering (preferred over checkpointSection). */
  checkpoint?: SessionCheckpoint;
  /** Override default coding-domain classifier (for tests or future domains). */
  domainClassifier?: DomainClassifier;
  /** Optional semantic embedder used to augment BM25 scoring. */
  embedder?: Embedder | null;
  /** Session-scoped embedding cache for context scoring. */
  embeddingCache?: EmbeddingCache;
  /**
   * Pre-fetched workflow patterns from the context engine DB (issue #92).
   * The compiler filters these to the classified task type and injects a
   * compact "Workflow Context" section when matching patterns exist.
   */
  workflowPatterns?: WorkflowPattern[];
}

export interface EngineCompileResult {
  prompt: string;
  metrics: CompileMetrics;
  scoreRecords: CompileScoreRecord[];
  /** Density-weighted fill ratio (gates compaction/emergency). */
  pressureRatio: number;
  pressureMode: PressureMode;
  weightedTokens: number;
  /** Raw prompt token fill ratio against the model window. */
  rawPressureRatio: number;
  excludedScoredUnits: number;
  /** Shorthand for taskClassification.taskType (domain-agnostic; narrow at budget call sites). */
  taskType: string;
  taskClassification: TaskClassificationResult;
  /** Budget allocation fractions used for this compilation (reflects classified task type). */
  budgetAllocation: BudgetAllocation;
}

function estTokens(text: string): number {
  return estimateTokens(text);
}

function renderVerbatimTurn(record: TurnRecord): string {
  const lines = [
    `### Turn ${record.turn}`,
    `User: ${record.userMessage}`,
    `PRAANA: ${record.assistantMessage}`,
  ];
  for (const tc of record.toolCalls) {
    lines.push(`Tool call: ${tc.tool}(${JSON.stringify(tc.args)})`);
    if (tc.resultArtifactId) {
      lines.push(`Result: [artifact: ${tc.resultArtifactId}]`);
    } else if (tc.resultText) {
      lines.push(`Result: ${tc.resultText}`);
    }
  }
  return lines.join("\n");
}

function renderTurnDigest(record: TurnRecord): string {
  const toolSummary =
    record.toolCalls.length === 0
      ? "no tools"
      : [...new Set(record.toolCalls.map((tc) => tc.tool))].join(", ");
  return [
    `### Turn ${record.turn} digest`,
    `User: ${record.userMessage}`,
    `Assistant: ${record.assistantMessage.slice(0, 400)}`,
    `Tools: ${toolSummary}`,
    record.filesWritten.length
      ? `Files: ${record.filesWritten.join(", ")}`
      : null,
    record.errors.length ? `Errors: ${record.errors.join("; ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildArtifactUnit(tc: TurnRecord["toolCalls"][number], turn: number): ContextUnit | null {
  if (!tc.resultArtifactId) return null;
  const command =
    typeof tc.args.command === "string"
      ? tc.args.command
      : typeof tc.args.path === "string"
        ? tc.args.path
        : undefined;
  const summary = tc.resultText?.slice(0, 600) ?? "(stored artifact)";
  const content = buildArtifactCard(
    tc.resultArtifactId,
    tc.tool,
    command,
    unitTokens(summary),
    summary,
  );
  return {
    id: tc.resultArtifactId,
    type: "artifact_card",
    content,
    tokens: unitTokens(content),
    sourceTurn: turn,
    score: 0,
    pinned: false,
    artifactRefs: [tc.resultArtifactId],
  };
}

function buildScoredUnits(
  records: TurnRecord[],
  currentTurn: number,
  activityEntries: ActivityEntry[],
  pressureMode: PressureMode,
): ContextUnit[] {
  const units: ContextUnit[] = [];

  for (const record of records) {
    const age = currentTurn - record.turn;
    if (age <= 2) continue;
    if (age >= 7) continue;

    if (pressureMode === "emergency") {
      if (age > 0) continue;
      for (const tc of record.toolCalls) {
        const unit = buildArtifactUnit(tc, record.turn);
        if (unit) units.push(unit);
      }
      continue;
    }

    if (pressureMode === "compact" && age > 6) {
      continue;
    }

    if (age >= 3 && age <= 6) {
      const digest = renderTurnDigest(record);
      units.push({
        id: `turn_${record.turn}`,
        type: "turn_digest",
        content: digest,
        tokens: unitTokens(digest),
        sourceTurn: record.turn,
        score: 0,
        pinned: false,
        artifactRefs: record.artifactIds,
      });
    }

    for (const tc of record.toolCalls) {
      const unit = buildArtifactUnit(tc, record.turn);
      if (unit) units.push(unit);
    }
  }

  for (const entry of activityEntries) {
    const content = `[turn ${entry.turn}] ${entry.summary}`;
    units.push({
      id: `activity_${entry.turn}_${entry.type}_${entry.summary.slice(0, 24)}`,
      type: "activity_entry",
      content,
      tokens: unitTokens(content),
      sourceTurn: entry.turn,
      score: 0,
      pinned: false,
      artifactRefs: entry.artifactRef ? [entry.artifactRef] : [],
    });
  }

  return units;
}

function buildVerbatimSection(
  records: TurnRecord[],
  currentTurn: number,
  tokenCap = BAND_VERBATIM_TOKENS,
): { text: string; tokens: number } {
  const recent = records
    .filter((r) => currentTurn - r.turn <= 2 && currentTurn - r.turn >= 0)
    .sort((a, b) => a.turn - b.turn);

  if (recent.length === 0) {
    return { text: "# Recent Turns\n\n(no recent turns)", tokens: estTokens("# Recent Turns") };
  }

  let body = recent.map(renderVerbatimTurn).join("\n\n");
  let tokens = estTokens(body);
  if (tokens > tokenCap) {
    const last = recent[recent.length - 1];
    body = renderVerbatimTurn(last);
    tokens = estTokens(body);
  }

  const text = ["# Recent Turns (verbatim)", "", body].join("\n");
  return { text, tokens: estTokens(text) };
}

function resolvePressureMode(
  pressureRatio: number,
  config: ContextEngineConfig,
): PressureMode {
  if (pressureRatio > config.pressure.emergency_at) return "emergency";
  if (pressureRatio > config.pressure.compact_at) return "compact";
  return "normal";
}

function pressureModeRank(mode: PressureMode): number {
  if (mode === "emergency") return 2;
  if (mode === "compact") return 1;
  return 0;
}

function maxPressureMode(...modes: PressureMode[]): PressureMode {
  return modes.reduce(
    (best, mode) =>
      pressureModeRank(mode) > pressureModeRank(best) ? mode : best,
    "normal" as PressureMode,
  );
}

/** Escalate to emergency when raw tokens overflow usable budget or exceed emergency_at. */
function resolveRawSafetyMode(
  totalTokens: number,
  usable: number,
  rawPressureRatio: number,
  config: ContextEngineConfig,
): PressureMode {
  if (totalTokens > usable) return "emergency";
  if (rawPressureRatio > config.pressure.emergency_at) return "emergency";
  return "normal";
}

function unitDensityKind(type: ContextUnitType): SectionDensityKind {
  switch (type) {
    case "turn_digest":
      return "turn_digest";
    case "artifact_card":
      return "artifact_card";
    case "activity_entry":
      return "activity_entry";
    case "verbatim_turn":
      return "verbatim_turn";
    case "memory_digest":
      return "memory_digest";
    case "active_state":
      return "active_state";
    case "checkpoint_section":
      return "pinned_infra";
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function renderCheckpointForMode(
  input: EngineCompileInput,
  pressureMode: PressureMode,
  checkpointBudgets: CheckpointSectionBudgets,
): { text: string; tokens: number; effective: number } {
  if (input.checkpoint) {
    const text = renderCheckpoint(input.checkpoint, { pressureMode, budgets: checkpointBudgets });
    const trimmed = text.trim();
    if (!trimmed) {
      return { text: "", tokens: 0, effective: 0 };
    }
    const estimate = estimateCheckpointEffectiveTokens(
      input.checkpoint.state,
      pressureMode,
    );
    return {
      text: trimmed,
      tokens: estTokens(trimmed),
      effective: estimate.effective,
    };
  }
  if (input.checkpointSection?.trim()) {
    const text = input.checkpointSection.trim();
    const tokens = estTokens(text);
    return { text, tokens, effective: tokens };
  }
  return { text: "", tokens: 0, effective: 0 };
}

function computeWeightedTokens(
  metrics: CompileMetrics,
  checkpointEffective: number,
  includedScored: ContextUnit[],
): number {
  let weighted = 0;
  weighted += effectiveTokens(metrics.systemFrameTokens, "pinned_infra");
  weighted += effectiveTokens(metrics.skillsCatalogTokens, "pinned_infra");
  weighted += effectiveTokens(metrics.workflowContextTokens ?? 0, "pinned_infra");
  weighted += checkpointEffective;
  weighted += effectiveTokens(metrics.recentTurnsTokens, "verbatim_turn");
  for (const unit of includedScored) {
    weighted += effectiveTokens(unit.tokens, unitDensityKind(unit.type));
  }
  weighted += effectiveTokens(metrics.crossSessionTokens, "memory_digest");
  weighted += effectiveTokens(metrics.activeStateTokens, "active_state");
  weighted += effectiveTokens(metrics.peripheralStubsTokens, "peripheral_state");
  weighted += effectiveTokens(metrics.currentInputTokens, "pinned_infra");
  return weighted;
}

function estimatePreliminaryWeighted(
  pinnedInfraTokens: number,
  verbatimTokens: number,
  currentInputTokens: number,
  checkpointEffective: number,
): number {
  return (
    effectiveTokens(pinnedInfraTokens, "pinned_infra") +
    effectiveTokens(verbatimTokens, "verbatim_turn") +
    effectiveTokens(currentInputTokens, "pinned_infra") +
    checkpointEffective
  );
}

interface CompilePassResult {
  prompt: string;
  metrics: CompileMetrics;
  scoreRecords: CompileScoreRecord[];
  checkpointEffective: number;
  includedScored: ContextUnit[];
}

interface BuildPassBase {
  systemFrame: string;
  systemFrameTokens: number;
  agentsContextTokens: number;
  agentsContextTruncated: boolean;
  verbatim: { text: string; tokens: number };
}

interface CompilePassPrecomputed {
  systemFrame: string;
  systemFrameTokens: number;
  agentsContextTokens: number;
  agentsContextTruncated: boolean;
  verbatim: { text: string; tokens: number };
  bandScoredRecentTokens: number;
  bandScoredOlderTokens: number;
  checkpointBudgets: CheckpointSectionBudgets;
}

async function compileEnginePass(
  input: EngineCompileInput,
  checkpointPressureMode: PressureMode,
  precomputed: CompilePassPrecomputed,
): Promise<CompilePassResult> {
  const sections: string[] = [];
  const metrics: Partial<CompileMetrics> = {};
  const compileTurn = input.currentTurn + 1;
  const scoreRecords: CompileScoreRecord[] = [];

  const reservedOutput = input.reservedOutputTokens ?? 0;
  const contextWindow = input.contextWindowTokens ?? input.tokenBudget;
  const usable = Math.max(
    0,
    Math.min(input.tokenBudget, contextWindow) - reservedOutput,
  );
  const maxMemoryTokens = Math.floor(usable * (input.memoriesBudgetRatio ?? 0.2));
  const maxSkillsSectionTokens = Math.floor(
    usable * (input.skillsSectionBudgetRatio ?? 0.2),
  );

  sections.push(precomputed.systemFrame);
  metrics.systemFrameTokens = precomputed.systemFrameTokens;
  metrics.agentsContextTokens = precomputed.agentsContextTokens;
  metrics.agentsContextTruncated = precomputed.agentsContextTruncated;

  let skillsSection = "";
  if (input.skillsPromptSection) {
    const { text, truncated } = trimSectionToTokenBudget(
      input.skillsPromptSection,
      maxSkillsSectionTokens,
      "skills section truncated to token budget",
    );
    skillsSection = text;
    metrics.skillsTruncated = truncated;
    sections.push(skillsSection);
  } else {
    metrics.skillsTruncated = false;
  }
  metrics.skillsCatalogTokens = skillsSection ? estTokens(skillsSection) : 0;

  // Workflow context (issue #92): inject matching patterns before the checkpoint.
  metrics.workflowContextTokens = 0;
  if (input.workflowPatterns && input.workflowPatterns.length > 0) {
    // Patterns are pre-filtered to the classified task type by
    // compileEngineWithMetrics before this function is called.
    const workflowSection = renderWorkflowContext(
      input.workflowPatterns,
      input.workflowPatterns[0]?.taskType ?? "general",
    );
    if (workflowSection) {
      sections.push(workflowSection);
      metrics.workflowContextTokens = estTokens(workflowSection);
    }
  }

  const checkpointRendered = renderCheckpointForMode(input, checkpointPressureMode, precomputed.checkpointBudgets);
  if (checkpointRendered.text) {
    sections.push(checkpointRendered.text);
  }
  metrics.checkpointTokens = checkpointRendered.tokens;

  sections.push(precomputed.verbatim.text);
  metrics.recentTurnsTokens = precomputed.verbatim.tokens;
  metrics.recentTurnsTruncated = false;

  const activityEntries = input.activityEntries ?? [];
  const scoredUnits = buildScoredUnits(
    input.turnRecords,
    input.currentTurn,
    activityEntries,
    checkpointPressureMode,
  );

  const weights = input.engineConfig.scoring;
  const userInput = input.userInput ?? "";

  const recentUnits = scoredUnits.filter(
    (u) => input.currentTurn - u.sourceTurn >= 3 && input.currentTurn - u.sourceTurn <= 6,
  );
  const olderUnits = scoredUnits.filter(
    (u) => input.currentTurn - u.sourceTurn > 6,
  );

  let precomputedVectors: Map<string, Float32Array> | undefined;
  if (input.embedder && input.userInput?.trim()) {
    const cache = input.embeddingCache ?? new EmbeddingCache();
    const candidateTexts = [
      userInput,
      ...recentUnits.map((u) => u.content),
      ...olderUnits.map((u) => u.content),
    ];
    try {
      precomputedVectors = await precomputeVectors(candidateTexts, input.embedder, cache);
    } catch (err) {
      // Semantic scoring is best-effort; fallback to BM25-only if embedding fails.
      getAppLogger().child("compiler").debug(
        "semantic embedding precompute failed; using BM25-only scoring",
        { details: { err: err instanceof Error ? err.message : String(err) } },
      );
      precomputedVectors = undefined;
    }
  }

  const rankedRecent = rankContextUnits(
    recentUnits,
    input.currentTurn,
    userInput,
    weights,
    input.hydratedTexts,
    precomputedVectors,
  );
  const rankedOlder = rankContextUnits(
    olderUnits,
    input.currentTurn,
    userInput,
    weights,
    input.hydratedTexts,
    precomputedVectors,
  );

  const recentPick = selectUnitsWithinBudget(rankedRecent, precomputed.bandScoredRecentTokens);
  const olderPick = selectUnitsWithinBudget(rankedOlder, precomputed.bandScoredOlderTokens);

  const recordScore = (
    unit: ContextUnit & { score: number; breakdown: ScoreBreakdown },
    included: boolean,
    band: number,
  ) => {
    scoreRecords.push({
      turn: compileTurn,
      unitId: unit.id,
      type: unit.type,
      score: Number(unit.score.toFixed(4)),
      included,
      band,
      tokens: unit.tokens,
      breakdown: {
        pin: Number(unit.breakdown.pin.toFixed(4)),
        recency: Number(unit.breakdown.recency.toFixed(4)),
        bm25: Number(unit.breakdown.bm25.toFixed(4)),
        semantic: Number(unit.breakdown.semantic.toFixed(4)),
        relevance: Number(unit.breakdown.relevance.toFixed(4)),
        hydrate_boost: Number((unit.breakdown.hydrate_boost).toFixed(4)),
      },
    });
  };

  for (const unit of rankedRecent) {
    recordScore(
      unit,
      recentPick.included.some((u) => u.id === unit.id),
      4,
    );
  }
  for (const unit of rankedOlder) {
    recordScore(
      unit,
      olderPick.included.some((u) => u.id === unit.id),
      5,
    );
  }

  const includedScored = [...recentPick.included, ...olderPick.included];
  if (includedScored.length > 0) {
    sections.push(
      ["# Scored Context", "", ...includedScored.map((u) => u.content)].join("\n"),
    );
  }

  let crossSection = "";
  if (input.memoryDigest && input.memoryDigest.trim()) {
    const { text, truncated } = trimSectionToTokenBudget(
      buildCrossSessionMemory(input.memoryDigest),
      maxMemoryTokens,
    );
    crossSection = text;
    metrics.memoryTruncated = truncated;
    sections.push(crossSection);
    metrics.crossSessionTokens = estTokens(crossSection);
  } else {
    metrics.crossSessionTokens = 0;
    metrics.memoryTruncated = false;
  }

  const active = buildActiveState(input.stateGraph);
  sections.push(active);
  metrics.activeStateTokens = estTokens(active);
  metrics.activeObjectCount = input.stateGraph.getActive().length;

  const peripheral = buildPeripheralStubs(input.stateGraph);
  if (peripheral) {
    sections.push(peripheral);
    metrics.peripheralStubsTokens = estTokens(peripheral);
    metrics.peripheralObjectCount = input.stateGraph.getPeripheral().length;
  } else {
    metrics.peripheralStubsTokens = 0;
    metrics.peripheralObjectCount = 0;
  }

  let currentSection = "";
  if (input.userInput) {
    currentSection = `## Current Input\n\nUser: ${input.userInput}`;
    sections.push(currentSection);
  }
  metrics.currentInputTokens = estTokens(currentSection);

  const fullPrompt = sections.join("\n\n");
  metrics.totalTokens = estTokens(fullPrompt);

  return {
    prompt: fullPrompt,
    metrics: metrics as CompileMetrics,
    scoreRecords,
    checkpointEffective: checkpointRendered.effective,
    includedScored,
  };
}

function buildCompilePassPrecomputed(
  input: EngineCompileInput,
  usable: number,
  verbatimTokenCap: number,
): BuildPassBase {
  const maxAgentsTokens = Math.floor(usable * (input.agentsBudgetRatio ?? 0.3));
  const stateSummary = buildStateSummary(input.stateGraph);
  const { text: agentsContext, truncated: agentsContextTruncated } =
    trimAgentsContext(input.agentsContext, maxAgentsTokens);
  const systemFrame = buildSystemFrame(
    input.cwd,
    input.sessionId,
    input.toolSchemas,
    stateSummary,
    agentsContext,
  );
  const verbatim = buildVerbatimSection(input.turnRecords, input.currentTurn, verbatimTokenCap);
  return {
    systemFrame,
    systemFrameTokens: estTokens(systemFrame),
    agentsContextTokens: agentsContext ? estTokens(agentsContext) : 0,
    agentsContextTruncated,
    verbatim,
  };
}

export async function compileEngineWithMetrics(
  input: EngineCompileInput,
): Promise<EngineCompileResult> {
  const classifier = input.domainClassifier ?? getDefaultDomainClassifier();
  const taskClassification = classifyTask(classifier, {
    userInput: input.userInput ?? "",
    turnRecords: input.turnRecords,
    activityEntries: input.activityEntries ?? [],
    currentTurn: input.currentTurn,
  });

  // --- Compute task-type-aware band caps ---
  const taskAlloc = classifier.getBudgetAllocation(taskClassification.taskType);
  const defaultAlloc = classifier.getBudgetAllocation("general");

  // Validate allocations once before scaling (catches misconfigured classifiers early).
  validateBudgetAllocation(taskAlloc);
  validateBudgetAllocation(defaultAlloc);

  const SCALE_MAXIMUM = 3; // defensive clamp for custom domains (max ~2.5× for coding domain)

  function scaleFrom(key: keyof BudgetAllocation): number {
    const baseValue = defaultAlloc[key];
    const taskValue = taskAlloc[key];
    // Both zero => the band is unused by this domain → disable.
    if (baseValue === 0 && taskValue === 0) return 0;
    // Default is zero but task wants it => give the full default cap (no ratio).
    if (baseValue === 0) return 1;
    // Normal ratio-scaling; clamp at 3× to prevent runaway allocations.
    return Math.min(taskValue / baseValue, SCALE_MAXIMUM);
  }

  const MINIMUM_BAND_CAP = 50;

  const scaledVerbatim = Math.max(MINIMUM_BAND_CAP, Math.round(BAND_VERBATIM_TOKENS * scaleFrom("verbatimTurns")));
  const scaledScoredRecent = Math.max(MINIMUM_BAND_CAP, Math.round(BAND_SCORED_RECENT_TOKENS * scaleFrom("artifacts")));
  const scaledScoredOlder = Math.max(MINIMUM_BAND_CAP, Math.round(BAND_SCORED_OLDER_TOKENS * scaleFrom("artifacts")));
  const checkpointBudgets: CheckpointSectionBudgets = {
    narrativeTokens: Math.max(MINIMUM_BAND_CAP, Math.round(NARRATIVE_RENDER_TOKENS * scaleFrom("narrative"))),
    decisionsTokens: Math.max(MINIMUM_BAND_CAP, Math.round(DECISIONS_SECTION_TOKENS * scaleFrom("decisions"))),
    errorsTokens: Math.max(MINIMUM_BAND_CAP, Math.round(ERRORS_SECTION_TOKENS * scaleFrom("errors"))),
  };
  // --- END ---

  const reservedOutput = input.reservedOutputTokens ?? 0;
  const contextWindow = input.contextWindowTokens ?? input.tokenBudget;
  const usable = Math.max(
    0,
    Math.min(input.tokenBudget, contextWindow) - reservedOutput,
  );
  const pressureDenominator = Math.max(1, contextWindow - reservedOutput);

  const base = buildCompilePassPrecomputed(input, usable, scaledVerbatim);
  const precomputed: CompilePassPrecomputed = {
    ...base,
    bandScoredRecentTokens: scaledScoredRecent,
    bandScoredOlderTokens: scaledScoredOlder,
    checkpointBudgets,
  };

  const normalCheckpointEstimate = input.checkpoint
    ? estimateCheckpointEffectiveTokens(input.checkpoint.state, "normal", checkpointBudgets).effective
    : input.checkpointSection?.trim()
      ? estTokens(input.checkpointSection.trim())
      : 0;

  const maxSkillsSectionTokens = Math.floor(
    usable * (input.skillsSectionBudgetRatio ?? 0.2),
  );
  const skillsRawTokens = input.skillsPromptSection
    ? estTokens(input.skillsPromptSection)
    : 0;
  const pinnedInfraEstimate =
    precomputed.systemFrameTokens +
    Math.min(skillsRawTokens, maxSkillsSectionTokens);

  const currentInputTokens = input.userInput
    ? estTokens(`## Current Input\n\nUser: ${input.userInput}`)
    : 0;

  const preliminaryWeighted = estimatePreliminaryWeighted(
    pinnedInfraEstimate,
    precomputed.verbatim.tokens,
    currentInputTokens,
    normalCheckpointEstimate,
  );
  let checkpointPressureMode = resolvePressureMode(
    preliminaryWeighted / pressureDenominator,
    input.engineConfig,
  );

  // Filter workflow patterns to the classified task type before compilation passes.
  // Both passes use the same filtered patterns so section content is stable.
  const matchingWorkflowPatterns = (input.workflowPatterns ?? []).filter(
    (p) => p.taskType === taskClassification.taskType,
  );
  const inputWithPatterns: EngineCompileInput =
    matchingWorkflowPatterns.length > 0
      ? { ...input, workflowPatterns: matchingWorkflowPatterns }
      : { ...input, workflowPatterns: undefined };

  let pass = await compileEnginePass(inputWithPatterns, checkpointPressureMode, precomputed);
  let weightedTokens = computeWeightedTokens(
    pass.metrics,
    pass.checkpointEffective,
    pass.includedScored,
  );
  let pressureRatio = weightedTokens / pressureDenominator;
  let pressureMode = resolvePressureMode(pressureRatio, input.engineConfig);

  if (pressureModeRank(pressureMode) > pressureModeRank(checkpointPressureMode)) {
    checkpointPressureMode = pressureMode;
    pass = await compileEnginePass(inputWithPatterns, checkpointPressureMode, precomputed);
    weightedTokens = computeWeightedTokens(
      pass.metrics,
      pass.checkpointEffective,
      pass.includedScored,
    );
    pressureRatio = weightedTokens / pressureDenominator;
    pressureMode = resolvePressureMode(pressureRatio, input.engineConfig);
  }

  let rawPressureRatio = pass.metrics.totalTokens / pressureDenominator;
  const rawSafetyMode = resolveRawSafetyMode(
    pass.metrics.totalTokens,
    usable,
    rawPressureRatio,
    input.engineConfig,
  );

  // pressureRatio reflects the final pass; pressureMode uses max(final, checkpoint)
  // because checkpoint is rendered at checkpointPressureMode, which may escalate on
  // the preliminary estimate before the final weighted total is known.
  let effectivePressureMode = maxPressureMode(
    checkpointPressureMode,
    pressureMode,
    rawSafetyMode,
  );

  if (pressureModeRank(rawSafetyMode) > pressureModeRank(checkpointPressureMode)) {
    checkpointPressureMode = rawSafetyMode;
    pass = await compileEnginePass(input, checkpointPressureMode, precomputed);
    weightedTokens = computeWeightedTokens(
      pass.metrics,
      pass.checkpointEffective,
      pass.includedScored,
    );
    pressureRatio = weightedTokens / pressureDenominator;
    pressureMode = resolvePressureMode(pressureRatio, input.engineConfig);
    rawPressureRatio = pass.metrics.totalTokens / pressureDenominator;
    effectivePressureMode = maxPressureMode(
      checkpointPressureMode,
      pressureMode,
      resolveRawSafetyMode(
        pass.metrics.totalTokens,
        usable,
        rawPressureRatio,
        input.engineConfig,
      ),
    );
  }

  if (pass.metrics.totalTokens > usable) {
    getAppLogger().child("compiler").warn(
      `Prompt estimated at ${pass.metrics.totalTokens} tokens, exceeds usable budget of ${usable} (window ${contextWindow}); emergency compaction engaged.`,
    );
  }

  const rankedRecentCount = pass.scoreRecords.filter((r) => r.band === 4).length;
  const rankedOlderCount = pass.scoreRecords.filter((r) => r.band === 5).length;
  const includedRecent = pass.scoreRecords.filter((r) => r.band === 4 && r.included).length;
  const includedOlder = pass.scoreRecords.filter((r) => r.band === 5 && r.included).length;
  const excludedScoredUnits =
    rankedRecentCount - includedRecent + (rankedOlderCount - includedOlder);

  return {
    prompt: pass.prompt,
    metrics: pass.metrics,
    scoreRecords: pass.scoreRecords,
    pressureRatio,
    pressureMode: effectivePressureMode,
    weightedTokens,
    rawPressureRatio,
    excludedScoredUnits,
    taskType: taskClassification.taskType,
    taskClassification,
    budgetAllocation: taskAlloc,
  };
}

export function explainUnitScore(
  unitId: string,
  records: CompileScoreRecord[],
  currentTurn: number,
  userInput: string,
  weights: ContextEngineConfig["scoring"],
  bandTokenBudget: number,
  bandUsedTokens: number,
): string[] {
  const record = records.find((r) => r.unitId === unitId);
  if (!record) {
    return [`No score record for unit "${unitId}" on the last compile.`];
  }

  const lines = [
    `Unit ${unitId} (${record.type}, turn ${currentTurn})`,
    `Score: ${record.score} (${record.included ? "included" : "excluded"} in prompt)`,
    `  pin:       ${record.breakdown.pin.toFixed(2)}`,
    `  recency:   ${record.breakdown.recency.toFixed(2)} (weight ${weights.w_recency})`,
    `  bm25:      ${record.breakdown.bm25.toFixed(2)} (weight ${weights.w_relevance})`,
    `  semantic:  ${record.breakdown.semantic.toFixed(2)} (weight ${weights.w_semantic ?? 0})`,
    `  relevance: ${record.breakdown.relevance.toFixed(2)} (max of bm25, semantic)`,
    `Budget band ${record.band}: ${bandUsedTokens}/${bandTokenBudget} tokens used`,
  ];

  if (userInput.trim()) {
    lines.push(`Relevance query: "${userInput.trim().slice(0, 80)}"`);
  }

  return lines;
}

export { recencyScore, scoreContextUnit };
