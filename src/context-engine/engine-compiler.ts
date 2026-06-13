import type { Event } from "../types.js";
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
import type {
  ActivityEntry,
  CompileScoreRecord,
  ContextUnit,
  PressureMode,
  TurnRecord,
} from "./types.js";
import type { ContextEngineConfig } from "../types.js";

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
}

export interface EngineCompileResult {
  prompt: string;
  metrics: CompileMetrics;
  scoreRecords: CompileScoreRecord[];
  pressureRatio: number;
  pressureMode: PressureMode;
  excludedScoredUnits: number;
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
): { text: string; tokens: number } {
  const recent = records
    .filter((r) => currentTurn - r.turn <= 2 && currentTurn - r.turn >= 0)
    .sort((a, b) => a.turn - b.turn);

  if (recent.length === 0) {
    return { text: "# Recent Turns\n\n(no recent turns)", tokens: estTokens("# Recent Turns") };
  }

  let body = recent.map(renderVerbatimTurn).join("\n\n");
  let tokens = estTokens(body);
  if (tokens > BAND_VERBATIM_TOKENS) {
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

export function compileEngineWithMetrics(
  input: EngineCompileInput,
): EngineCompileResult {
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
  const pressureDenominator = Math.max(1, contextWindow - reservedOutput);
  const maxMemoryTokens = Math.floor(usable * (input.memoriesBudgetRatio ?? 0.2));
  const maxAgentsTokens = Math.floor(usable * (input.agentsBudgetRatio ?? 0.3));
  const maxSkillsSectionTokens = Math.floor(
    usable * (input.skillsSectionBudgetRatio ?? 0.2),
  );

  const stateSummary = buildStateSummary(input.stateGraph);
  const { text: agentsContext, truncated: agentsTruncated } = trimAgentsContext(
    input.agentsContext,
    maxAgentsTokens,
  );
  metrics.agentsContextTruncated = agentsTruncated;

  const frame = buildSystemFrame(
    input.cwd,
    input.sessionId,
    input.toolSchemas,
    stateSummary,
    agentsContext,
  );
  sections.push(frame);
  metrics.systemFrameTokens = estTokens(frame);
  metrics.agentsContextTokens = agentsContext ? estTokens(agentsContext) : 0;

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

  let checkpointSection = "";
  if (input.checkpointSection?.trim()) {
    checkpointSection = input.checkpointSection.trim();
    sections.push(checkpointSection);
  }
  metrics.checkpointTokens = checkpointSection ? estTokens(checkpointSection) : 0;

  const verbatim = buildVerbatimSection(input.turnRecords, input.currentTurn);
  sections.push(verbatim.text);
  metrics.recentTurnsTokens = verbatim.tokens;
  metrics.recentTurnsTruncated = false;

  const pinnedTokens =
    estTokens(sections.join("\n\n")) +
    (input.userInput ? estTokens(`## Current Input\n\nUser: ${input.userInput}`) : 0);

  let pressureRatio = pinnedTokens / pressureDenominator;
  let pressureMode = resolvePressureMode(pressureRatio, input.engineConfig);

  const activityEntries = input.activityEntries ?? [];
  let scoredUnits = buildScoredUnits(
    input.turnRecords,
    input.currentTurn,
    activityEntries,
    pressureMode,
  );

  const weights = input.engineConfig.scoring;
  const userInput = input.userInput ?? "";

  const recentUnits = scoredUnits.filter(
    (u) => input.currentTurn - u.sourceTurn >= 3 && input.currentTurn - u.sourceTurn <= 6,
  );
  const olderUnits = scoredUnits.filter(
    (u) => input.currentTurn - u.sourceTurn > 6,
  );

  const rankedRecent = rankContextUnits(recentUnits, input.currentTurn, userInput, weights);
  const rankedOlder = rankContextUnits(olderUnits, input.currentTurn, userInput, weights);

  const recentPick = selectUnitsWithinBudget(rankedRecent, BAND_SCORED_RECENT_TOKENS);
  const olderPick = selectUnitsWithinBudget(rankedOlder, BAND_SCORED_OLDER_TOKENS);

  const recordScore = (
    unit: ContextUnit & { score: number; breakdown: { pin: number; recency: number; relevance: number } },
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
        relevance: Number(unit.breakdown.relevance.toFixed(4)),
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

  const scoredSections: string[] = [];
  const includedScored = [...recentPick.included, ...olderPick.included];
  if (includedScored.length > 0) {
    scoredSections.push(
      "# Scored Context",
      "",
      ...includedScored.map((u) => u.content),
    );
    sections.push(scoredSections.join("\n"));
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
  pressureRatio = metrics.totalTokens / pressureDenominator;
  pressureMode = resolvePressureMode(pressureRatio, input.engineConfig);

  if (metrics.totalTokens > usable) {
    getAppLogger().child("compiler").warn(
      `Prompt estimated at ${metrics.totalTokens} tokens, exceeds usable budget of ${usable} (window ${contextWindow}).`,
    );
  }

  const excludedScoredUnits =
    rankedRecent.length -
    recentPick.included.length +
    (rankedOlder.length - olderPick.included.length);

  return {
    prompt: fullPrompt,
    metrics: metrics as CompileMetrics,
    scoreRecords,
    pressureRatio,
    pressureMode,
    excludedScoredUnits,
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
    `  relevance: ${record.breakdown.relevance.toFixed(2)} (weight ${weights.w_relevance})`,
    `Budget band ${record.band}: ${bandUsedTokens}/${bandTokenBudget} tokens used`,
  ];

  if (userInput.trim()) {
    lines.push(`Relevance query: "${userInput.trim().slice(0, 80)}"`);
  }

  return lines;
}

export { recencyScore, scoreContextUnit };
