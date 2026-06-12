import type Database from "better-sqlite3";
import {
  getSessionCheckpoint,
  listAllActivityEntries,
  listTurnDigests,
  upsertSessionCheckpoint,
} from "./db.js";
import { estimateTokens } from "./summarize.js";
import {
  buildNarrativeEntry,
  decisionSummary,
  detectCompletedPlanItems,
  extractPlanItems,
  isNarrativeWorthy,
  normalizeTurnDigest,
} from "./turn-digest.js";
import type {
  ActivityEntry,
  CheckpointDecisionEntry,
  CheckpointDraft,
  CheckpointErrorEntry,
  CheckpointPlanEntry,
  CheckpointState,
  SessionCheckpoint,
  TurnDigest,
} from "./types.js";

const DECISION_IDLE_TURNS = 10;
const FILE_IDLE_TURNS = 10;
const MAX_FINDINGS = 30;
const MAX_FIXED_ERRORS = 20;
const MAX_NARRATIVE_ENTRIES = 30;
const NARRATIVE_RENDER_TOKENS = 400;
const RATIONALE_MAX_CHARS = 240;
const DECISIONS_SECTION_TOKENS = 800;
const FINDINGS_SECTION_TOKENS = 300;
const PLAN_SECTION_TOKENS = 400;

type LegacyCheckpointState = CheckpointState & {
  plan?: string;
  volatile?: string;
};

export function createEmptyCheckpointState(): CheckpointState {
  return {
    activeRequest: "",
    plans: [],
    constraints: [],
    decisions: [],
    files: [],
    findings: [],
    errors: [],
    questions: [],
    activity: [],
    narrative: [],
    lastReconciledTurn: -1,
  };
}

export function normalizeCheckpointState(
  raw: Partial<LegacyCheckpointState>,
): CheckpointState {
  const state = createEmptyCheckpointState();
  state.activeRequest = raw.activeRequest ?? "";
  state.constraints = raw.constraints ?? [];
  state.decisions = (raw.decisions ?? []).map((d) => ({ ...d }));
  state.files = (raw.files ?? []).map((f) => ({ ...f }));
  state.findings = (raw.findings ?? []).map((f) => ({ ...f }));
  state.errors = (raw.errors ?? []).map((e) => ({ ...e }));
  state.questions = (raw.questions ?? []).map((q) => ({ ...q }));
  state.activity = raw.activity ?? [];
  state.lastReconciledTurn = raw.lastReconciledTurn ?? -1;

  if (raw.plans && raw.plans.length > 0) {
    state.plans = raw.plans.map((p) => ({ ...p }));
  } else if (raw.plan?.trim()) {
    state.plans = [
      {
        text: raw.plan.trim(),
        turn: raw.lastReconciledTurn ?? 0,
        superseded: false,
      },
    ];
  }

  state.narrative = (raw.narrative ?? []).map((n) => ({ ...n }));

  return state;
}

export function createEmptyCheckpoint(): SessionCheckpoint {
  return { version: 1, state: createEmptyCheckpointState() };
}

export function reconcileCheckpoint(
  state: CheckpointState,
  digest: TurnDigest,
  draft: CheckpointDraft,
  turn: number,
): CheckpointState {
  const normalizedDigest = normalizeTurnDigest(digest);
  const previousIntent = state.activeRequest;

  const next: CheckpointState = {
    ...state,
    constraints: [...state.constraints],
    decisions: state.decisions.map((d) => ({ ...d })),
    files: state.files.map((f) => ({ ...f })),
    findings: state.findings.map((f) => ({ ...f })),
    errors: state.errors.map((e) => ({ ...e })),
    questions: state.questions.map((q) => ({ ...q })),
    plans: state.plans.map((p) => ({ ...p })),
    narrative: state.narrative.map((n) => ({ ...n })),
    activity: [...draft.recentActivity],
    lastReconciledTurn: turn,
  };

  next.activeRequest = normalizedDigest.userIntent;

  for (const constraint of normalizedDigest.constraints) {
    if (!next.constraints.includes(constraint)) {
      next.constraints.push(constraint);
    }
  }

  for (const decision of normalizedDigest.decisions) {
    const summary = decisionSummary(decision);
    const rationale =
      typeof decision === "string" ? undefined : decision.rationale;
    const existingIdx = next.decisions.findIndex(
      (d) => d.summary === summary && d.turn === turn,
    );
    if (existingIdx < 0) {
      next.decisions.push({ summary, rationale, turn });
    } else if (rationale && !next.decisions[existingIdx].rationale) {
      next.decisions[existingIdx].rationale = rationale;
    }
  }
  next.decisions = next.decisions.map((d) => ({
    ...d,
    compact: turn - d.turn >= DECISION_IDLE_TURNS,
  }));

  for (const path of normalizedDigest.filesChanged) {
    const existing = next.files.find((f) => f.path === path);
    if (existing) {
      existing.turn = turn;
    } else {
      next.files.push({ path, turn });
    }
  }
  next.files = next.files.filter((f) => turn - f.turn < FILE_IDLE_TURNS);

  for (const artifactRef of normalizedDigest.artifactRefs) {
    next.findings.push({
      summary: `Artifact ${artifactRef}`,
      artifactRef,
      turn,
    });
  }
  while (next.findings.length > MAX_FINDINGS) {
    next.findings.shift();
  }

  next.errors = reconcileErrors(state.errors, normalizedDigest, draft, turn);
  next.plans = reconcilePlans(
    next.plans,
    normalizedDigest.extractedPlan,
    normalizedDigest,
    turn,
  );

  if (isNarrativeWorthy(normalizedDigest, previousIntent)) {
    const text = buildNarrativeEntry(normalizedDigest, previousIntent);
    if (text) {
      next.narrative.push({ turn, text });
      while (next.narrative.length > MAX_NARRATIVE_ENTRIES) {
        next.narrative.shift();
      }
    }
  }

  return next;
}

function reconcilePlans(
  previous: CheckpointPlanEntry[],
  extractedPlan: string | undefined,
  digest: TurnDigest,
  turn: number,
): CheckpointPlanEntry[] {
  if (!extractedPlan) {
    return previous;
  }

  const next = previous.map((p) => ({ ...p }));
  const currentIdx = findLastActivePlanIndex(next);

  if (currentIdx >= 0 && next[currentIdx].text === extractedPlan) {
    return next;
  }

  if (currentIdx >= 0) {
    const current = next[currentIdx];
    const completed = detectCompletedPlanItems(
      extractPlanItems(current.text),
      digest,
    );
    next[currentIdx] = {
      ...current,
      superseded: true,
      supersededTurn: turn,
      completed:
        completed.length > 0
          ? completed
          : current.completed,
    };
  }

  next.push({
    text: extractedPlan,
    turn,
    superseded: false,
  });

  return next;
}

function reconcileErrors(
  previous: CheckpointErrorEntry[],
  digest: TurnDigest,
  draft: CheckpointDraft,
  turn: number,
): CheckpointErrorEntry[] {
  const open: CheckpointErrorEntry[] = draft.openErrors.map((err) => ({
    key: err.key,
    message: err.message,
    turn: err.turn,
    fixed: false,
  }));

  const fixed = previous.filter((e) => e.fixed);
  for (const label of digest.errorsFixed) {
    const match = fixed.find(
      (e) => e.message === label || e.message === `Fixed: ${label}`,
    );
    if (!match) {
      fixed.push({
        key: `fixed:${label}`,
        message: `Fixed: ${label}`,
        turn,
        fixed: true,
        fixedTurn: turn,
      });
    }
  }

  const merged = [...open, ...fixed];
  const seen = new Set<string>();
  const deduped: CheckpointErrorEntry[] = [];
  for (const entry of merged) {
    const id = entry.fixed ? `fixed:${entry.message}` : entry.key;
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(entry);
  }

  const openErrors = deduped.filter((e) => !e.fixed);
  const fixedErrors = deduped.filter((e) => e.fixed).slice(-MAX_FIXED_ERRORS);
  return [...openErrors, ...fixedErrors];
}

export function replayCheckpointFromDigests(
  digests: TurnDigest[],
  activityEntries: ActivityEntry[],
): CheckpointState {
  let state = createEmptyCheckpointState();
  const openErrors: CheckpointDraft["openErrors"] = [];

  for (const digest of digests.map(normalizeTurnDigest)) {
    for (const message of digest.errorsNew) {
      if (!openErrors.some((e) => e.message === message)) {
        openErrors.push({
          key: message,
          message,
          turn: digest.turnId,
          tool: "unknown",
        });
      }
    }
    for (const fixed of digest.errorsFixed) {
      const idx = openErrors.findIndex(
        (e) => e.message.includes(fixed) || fixed.includes(e.message),
      );
      if (idx >= 0) openErrors.splice(idx, 1);
    }

    const draft: CheckpointDraft = {
      lastUserIntent: digest.userIntent,
      openErrors: [...openErrors],
      recentDecisions: state.decisions.map((d) => ({
        summary: d.summary,
        turn: d.turn,
      })),
      recentConstraints: [...state.constraints],
      recentActivity: activityEntries
        .filter((a) => a.turn <= digest.turnId)
        .slice(-15),
    };
    state = reconcileCheckpoint(state, digest, draft, digest.turnId);
  }

  return state;
}

function findLastActivePlanIndex(plans: CheckpointPlanEntry[]): number {
  for (let i = plans.length - 1; i >= 0; i--) {
    if (!plans[i].superseded) return i;
  }
  return -1;
}

function truncateRationale(rationale: string): string {
  if (rationale.length <= RATIONALE_MAX_CHARS) return rationale;
  return rationale.slice(0, RATIONALE_MAX_CHARS - 1) + "…";
}

function renderDecision(
  decision: CheckpointDecisionEntry,
  index: number,
): string {
  const label = `D${index + 1}`;
  const rationale = decision.rationale
    ? truncateRationale(decision.rationale)
    : "";
  if (rationale) {
    return decision.compact
      ? `- ${label} [turn ${decision.turn}]: ${decision.summary} — ${rationale}`
      : `- ${label} [turn ${decision.turn}]: ${decision.summary} (rationale: ${rationale})`;
  }
  return `- ${label} [turn ${decision.turn}]: ${decision.summary}`;
}

function renderPlanSection(plans: CheckpointPlanEntry[]): string[] {
  if (plans.length === 0) return [];

  const currentIdx = findLastActivePlanIndex(plans);
  if (currentIdx < 0) return [];

  const lines = ["### Plan"];
  const current = plans[currentIdx];
  lines.push(`Current (turn ${current.turn}): ${current.text.replace(/\n/g, "; ")}`);

  const superseded = plans.filter((p) => p.superseded);
  if (superseded.length > 0) {
    lines.push("Superseded plans:");
    for (const plan of superseded) {
      const completed =
        plan.completed && plan.completed.length > 0
          ? ` — completed: ${plan.completed.join(", ")}`
          : "";
      lines.push(
        `- [turn ${plan.turn}] ${plan.text.replace(/\n/g, "; ")}${completed}`,
      );
    }
  }

  return lines;
}

function renderNarrativeSection(
  narrative: CheckpointState["narrative"],
): string[] {
  if (narrative.length === 0) return [];
  // Token-budgeted: keep as many recent entries as fit within the render budget.
  // If the full prose exceeds budget, trim oldest entries first.
  let entries = [...narrative];
  let prose = entries.map((e) => e.text).join(" ");
  while (entries.length > 1 && estimateTokens(prose) > NARRATIVE_RENDER_TOKENS) {
    entries.shift();
    prose = entries.map((e) => e.text).join(" ");
  }
  return ["### Session narrative", prose];
}

function renderFindingsSection(
  findings: CheckpointState["findings"],
): string[] {
  if (findings.length === 0) return [];
  const recent = findings.slice(-15);
  return [
    "### Findings",
    ...recent.map(
      (f, i) =>
        `- F${i + 1} [turn ${f.turn}]: ${f.summary}${
          f.artifactRef ? ` (${f.artifactRef})` : ""
        }`,
    ),
  ];
}

export function renderCheckpoint(checkpoint: SessionCheckpoint): string {
  const { state } = checkpoint;
  const sections: string[] = ["## Session Checkpoint", ""];

  if (state.activeRequest) {
    sections.push(
      "### Active Request",
      trimSection(state.activeRequest, 200),
      "",
    );
  }

  const narrativeLines = renderNarrativeSection(state.narrative);
  if (narrativeLines.length > 0) {
    sections.push(...narrativeLines, "");
  }

  const planLines = trimSectionLines(
    renderPlanSection(state.plans),
    PLAN_SECTION_TOKENS,
  );
  if (planLines.length > 0) {
    sections.push(...planLines, "");
  }

  if (state.constraints.length > 0) {
    sections.push(
      "### Constraints",
      ...state.constraints.map((c, i) => `- C${i + 1}: ${c}`),
      "",
    );
  }

  const decisions = state.decisions.slice(-20);
  if (decisions.length > 0) {
    const decisionLines = trimSectionLines(
      [
        "### Decisions",
        ...decisions.map((d, i) => renderDecision(d, i)),
      ],
      DECISIONS_SECTION_TOKENS,
    );
    sections.push(...decisionLines, "");
  }

  if (state.files.length > 0) {
    sections.push(
      "### Files in play",
      ...state.files.map((f) => `- ${f.path} (turn ${f.turn})`),
      "",
    );
  }

  const findingsLines = trimSectionLines(
    renderFindingsSection(state.findings),
    FINDINGS_SECTION_TOKENS,
  );
  if (findingsLines.length > 0) {
    sections.push(...findingsLines, "");
  }

  const openErrors = state.errors.filter((e) => !e.fixed);
  if (openErrors.length > 0) {
    sections.push(
      "### Open errors",
      ...openErrors.map((e) => `- ${e.message}`),
      "",
    );
  }

  const fixedErrors = state.errors.filter((e) => e.fixed);
  if (fixedErrors.length > 0) {
    sections.push(
      "### Fixed errors",
      ...fixedErrors.map(
        (e) => `- [turn ${e.fixedTurn ?? e.turn}] ${e.message}`,
      ),
      "",
    );
  }

  if (state.activity.length > 0) {
    sections.push(
      "### Recent activity",
      ...state.activity.map(
        (a) => `- [turn ${a.turn}] ${a.summary}`,
      ),
      "",
    );
  }

  return sections.join("\n").trimEnd();
}

export function renderContextSummary(
  checkpoint: SessionCheckpoint,
  stats?: { artifactCount?: number },
): string {
  const { state } = checkpoint;
  const lines = ["## Context Summary", ""];

  if (state.activeRequest) {
    lines.push("### Active intent", state.activeRequest, "");
  }

  const recentDecisions = state.decisions.slice(-5);
  if (recentDecisions.length > 0) {
    lines.push(
      "### Recent decisions (last 5)",
      ...recentDecisions.map((d) => {
        const rationale = d.rationale ? ` — ${d.rationale}` : "";
        return `- ${d.summary}${rationale}`;
      }),
      "",
    );
  }

  const openErrors = state.errors.filter((e) => !e.fixed);
  if (openErrors.length > 0) {
    lines.push(
      "### Open errors",
      ...openErrors.map((e) => `- ${e.message}`),
      "",
    );
  }

  const recentActivity = state.activity.slice(-5);
  if (recentActivity.length > 0) {
    lines.push(
      "### Recent activity (last 5)",
      ...recentActivity.map((a) => `- [turn ${a.turn}] ${a.summary}`),
      "",
    );
  }

  const fixedCount = state.errors.filter((e) => e.fixed).length;
  const turnCount = state.lastReconciledTurn >= 0 ? state.lastReconciledTurn + 1 : 0;
  const artifactCount = stats?.artifactCount ?? 0;
  lines.push(
    "### Session stats",
    `turns: ${turnCount}, artifacts: ${artifactCount}, open errors: ${openErrors.length}, fixed errors: ${fixedCount}`,
  );

  return lines.join("\n");
}

function trimSection(text: string, maxTokens: number): string {
  const budgetChars = maxTokens * 4;
  if (text.length <= budgetChars) return text;
  return text.slice(0, budgetChars - 16) + "\n…[truncated]";
}

function trimSectionLines(lines: string[], maxTokens: number): string[] {
  if (lines.length === 0) return lines;
  const joined = lines.join("\n");
  const trimmed = trimSection(joined, maxTokens);
  if (trimmed === joined) return lines;
  return [trimmed];
}

export function checkpointTokenEstimate(checkpoint: SessionCheckpoint): {
  text: string;
  tokens: number;
} {
  const text = renderCheckpoint(checkpoint);
  return { text, tokens: estimateTokens(text) };
}

export class CheckpointStore {
  private checkpoint: SessionCheckpoint;

  private constructor(
    private readonly db: Database.Database,
    private readonly sessionId: string,
    checkpoint: SessionCheckpoint,
  ) {
    this.checkpoint = checkpoint;
  }

  static open(db: Database.Database, sessionId: string): CheckpointStore {
    const saved = getSessionCheckpoint(db, sessionId);
    if (saved) {
      const normalized: SessionCheckpoint = {
        version: 1,
        state: normalizeCheckpointState(saved.state),
      };
      return new CheckpointStore(db, sessionId, normalized);
    }

    const digests = listTurnDigests(db, sessionId).map(normalizeTurnDigest);
    if (digests.length > 0) {
      const activity = listAllActivityEntries(db, sessionId);
      const state = replayCheckpointFromDigests(digests, activity);
      const rebuilt: SessionCheckpoint = { version: 1, state };
      upsertSessionCheckpoint(db, sessionId, rebuilt);
      return new CheckpointStore(db, sessionId, rebuilt);
    }

    return new CheckpointStore(db, sessionId, createEmptyCheckpoint());
  }

  reconcile(digest: TurnDigest, draft: CheckpointDraft, turn: number): void {
    this.checkpoint = {
      version: 1,
      state: reconcileCheckpoint(
        this.checkpoint.state,
        normalizeTurnDigest(digest),
        draft,
        turn,
      ),
    };
  }

  persist(): void {
    upsertSessionCheckpoint(this.db, this.sessionId, this.checkpoint);
  }

  getCheckpoint(): SessionCheckpoint {
    return this.checkpoint;
  }

  render(): string {
    const text = renderCheckpoint(this.checkpoint);
    return text.trim().length > 0 ? text : "";
  }

  renderContextSummary(stats?: { artifactCount?: number }): string {
    return renderContextSummary(this.checkpoint, stats);
  }
}
