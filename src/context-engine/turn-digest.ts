import type { StateGraph } from "../state-graph.js";
import type { StateSnapshot, TurnDigest, TurnDigestDecision } from "./types.js";
import { diffStateGraph } from "./state-snapshot.js";

const USER_INTENT_MAX = 120;
const NARRATIVE_MAX_CHARS = 160;

export function extractUserIntent(userMessage: string): string {
  const trimmed = userMessage.trim().replace(/\s+/g, " ");
  if (trimmed.length <= USER_INTENT_MAX) return trimmed;
  return trimmed.slice(0, USER_INTENT_MAX - 3) + "...";
}

export function buildToolSummary(record: {
  toolCalls: Array<{ tool: string }>;
}): string {
  if (record.toolCalls.length === 0) return "no tools";
  const counts = new Map<string, number>();
  for (const tc of record.toolCalls) {
    counts.set(tc.tool, (counts.get(tc.tool) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([tool, count]) =>
    count > 1 ? `${tool}×${count}` : tool,
  );
  return parts.join(", ");
}

export function decisionSummary(
  decision: TurnDigestDecision | string,
): string {
  return typeof decision === "string" ? decision : decision.summary;
}

export function normalizeTurnDigest(raw: TurnDigest): TurnDigest {
  const decisions = (raw.decisions ?? []).map((d) =>
    typeof d === "string" ? { summary: d } : d,
  );
  return {
    ...raw,
    filesWritten: raw.filesWritten ?? [],
    decisions,
  };
}

/**
 * Extract implicit constraints from user messages.
 *
 * **Architecture note:** Regex is a minimal safety net for the most syntactically
 * unambiguous patterns only. It is NOT the primary mechanism for capturing
 * implicit knowledge — the system prompt nudge (see `compiler.ts` "Implicit
 * Knowledge Capture") is the primary mechanism, because the LLM is the
 * language-understanding component, not regex.
 *
 * We only capture patterns where the syntax is unambiguous enough that missing
 * them would be worse than occasionally over-capturing. Specifically:
 * - "not X, Y" corrections (the user directly reversing a wrong choice)
 *
 * Patterns like "we use", "let's use", "I prefer", "make sure", "how about"
 * are NOT captured here because they are too variable in natural language.
 * Those are the LLM's responsibility via the system prompt nudge.
 */
export function extractImplicitConstraints(userMessage: string): string[] {
  const constraints: string[] = [];
  const text = userMessage.trim();
  if (!text) return constraints;

  // "not X, Y" — the most unambiguous correction pattern.
  // "not npm, pnpm" → "Use pnpm, not npm"
  // "not npm, but actually pnpm" → "Use pnpm, not npm"
  const notPattern = text.match(
    /\bnot\s+([^,]+?),\s*(?:but\s+)?(?:actually\s+)?(.+?)(?:[.!?]|$)/i,
  );
  if (notPattern) {
    const avoided = notPattern[1].trim();
    const preferred = notPattern[2].trim().replace(/[.!?]$/, "");
    constraints.push(`Use ${preferred}, not ${avoided}`);
  }

  return constraints;
}

export function isNarrativeWorthy(
  digest: TurnDigest,
  previousIntent?: string,
): boolean {
  if (digest.decisions.length > 0) return true;
  if (digest.constraints.length > 0) return true;
  if (digest.errorsNew.length > 0 || digest.errorsFixed.length > 0) return true;
  if (digest.filesWritten.length > 0) return true;
  if (previousIntent && digest.userIntent !== previousIntent) return true;
  return false;
}

export function buildNarrativeEntry(
  digest: TurnDigest,
  previousIntent?: string,
): string | null {
  const parts: string[] = [];

  if (previousIntent && digest.userIntent !== previousIntent) {
    parts.push(digest.userIntent);
  }

  if (digest.decisions.length > 0) {
    const summaries = digest.decisions.map(decisionSummary).join(", ");
    parts.push(`Decided: ${summaries}`);
  }

  if (digest.errorsFixed.length > 0) {
    parts.push(`Fixed: ${digest.errorsFixed.join(", ")}`);
  }

  if (digest.errorsNew.length > 0) {
    parts.push(`Error: ${digest.errorsNew.join(", ")}`);
  }

  if (digest.filesWritten.length > 0) {
    parts.push(`Wrote: ${digest.filesWritten.join(", ")}`);
  }

  if (digest.constraints.length > 0) {
    parts.push(`Constraints: ${digest.constraints.join(", ")}`);
  }

  if (parts.length === 0) return null;

  let text = parts.join(". ");
  if (text.length > NARRATIVE_MAX_CHARS) {
    text = text.slice(0, NARRATIVE_MAX_CHARS - 1) + "…";
  }
  return text;
}

const PLAN_KEYWORDS =
  /\b(?:the plan|my approach|i'll start by|next i'll)\b/i;
const NUMBERED_LIST = /(?:^|\n)\s*\d+\.\s+.+/m;
const STEP_MARKERS =
  /(?:^|\n)\s*(?:-\s*step\s*\d+:|step\s*\d+:|first:|next:)/i;
const MARKDOWN_TASKS = /(?:^|\n)\s*-\s*\[[ x]\]\s+.+/m;
const BULLET_LIST = /(?:^|\n)\s*[-*]\s+.+/m;

export function extractPlan(assistantMessage: string): string | null {
  const text = assistantMessage.trim();
  if (!text) return null;

  // Skip content inside code blocks (plans don't live there)
  const stripped = text.replace(/```[\s\S]*?```/g, "");

  const hasPlanSignal =
    PLAN_KEYWORDS.test(stripped) ||
    NUMBERED_LIST.test(stripped) ||
    STEP_MARKERS.test(stripped) ||
    MARKDOWN_TASKS.test(stripped);

  if (!hasPlanSignal) return null;

  const lines = stripped.split("\n");
  const planLines: string[] = [];
  let inPlan = false;

  for (const line of lines) {
    // Numbered items
    if (/^\s*\d+\.\s+/.test(line)) {
      inPlan = true;
      planLines.push(line.trim());
      continue;
    }
    // Step markers
    if (STEP_MARKERS.test(line)) {
      inPlan = true;
      planLines.push(line.trim());
      continue;
    }
    // Markdown task items
    if (/^\s*-\s*\[[ x]\]\s+/.test(line)) {
      inPlan = true;
      planLines.push(line.trim());
      continue;
    }
    // Sub-items / continuation bullets within a plan block
    if (inPlan && /^\s*[-*]\s+/.test(line)) {
      planLines.push(line.trim());
      continue;
    }
    // Indented sub-items (under a numbered step)
    if (inPlan && /^\s{2,}\S/.test(line)) {
      planLines.push(line.trim());
      continue;
    }
    // Blank lines within plan block — skip
    if (inPlan && line.trim() === "") {
      continue;
    }
    // Non-plan content breaks the block
    if (inPlan && planLines.length > 0) {
      break;
    }
  }

  if (planLines.length >= 2) {
    return planLines.join("\n");
  }

  const planMatch = stripped.match(
    /(?:the plan is|my approach is|i'll start by)\s*[:\-]?\s*(?:to\s+)?(.+?)(?:\n\n|$)/i,
  );
  if (planMatch) {
    return planMatch[1].trim();
  }

  if (NUMBERED_LIST.test(stripped)) {
    const numbered = lines.filter((line) => /^\s*\d+\.\s+/.test(line));
    if (numbered.length >= 2) {
      return numbered.map((line) => line.trim()).join("\n");
    }
  }

  return null;
}

export function extractPlanItems(planText: string): string[] {
  const items: string[] = [];
  for (const line of planText.split("\n")) {
    const numbered = line.match(/^\s*\d+\.\s+(.+)/);
    if (numbered) {
      items.push(numbered[1].trim());
      continue;
    }
    const step = line.match(/^\s*(?:-\s*)?(?:step\s*\d+:|first:|next:)\s*(.+)/i);
    if (step) {
      items.push(step[1].trim());
      continue;
    }
    const task = line.match(/^\s*-\s*\[[ x]\]\s+(.+)/);
    if (task) {
      items.push(task[1].trim());
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) {
      items.push(bullet[1].trim());
    }
  }
  if (items.length === 0 && planText.trim()) {
    return planText
      .split(/[,;]/)
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return items;
}

export function detectCompletedPlanItems(
  planItems: string[],
  digest: TurnDigest,
): string[] {
  const signals = [
    ...digest.filesChanged,
    ...digest.filesWritten,
    ...digest.decisions.map(decisionSummary),
    ...digest.constraints,
  ]
    .join(" ")
    .toLowerCase();

  return planItems.filter((item) => {
    const keywords = item
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3);
    return keywords.some((keyword) => signals.includes(keyword));
  });
}

export function extractTurnDigest(input: {
  turn: number;
  userMessage: string;
  record: {
    filesRead: string[];
    filesWritten: string[];
    assistantMessage: string;
    toolCalls: Array<{ tool: string }>;
    artifactIds: string[];
  };
  stateBefore: StateSnapshot;
  stateGraph: StateGraph;
  errorsNew: string[];
  errorsFixed: string[];
}): TurnDigest {
  const { decisions, constraints: stateConstraints } = diffStateGraph(
    input.stateBefore,
    input.stateGraph.snapshot(),
  );

  const implicitConstraints = extractImplicitConstraints(input.userMessage);
  const constraints = [
    ...new Set([...stateConstraints, ...implicitConstraints]),
  ];

  const filesChanged = [
    ...new Set([...input.record.filesRead, ...input.record.filesWritten]),
  ];

  const extractedPlan = extractPlan(input.record.assistantMessage);

  return {
    turnId: input.turn,
    userIntent: extractUserIntent(input.userMessage),
    filesChanged,
    filesWritten: [...input.record.filesWritten],
    artifactRefs: [...input.record.artifactIds],
    decisions,
    constraints,
    errorsNew: input.errorsNew,
    errorsFixed: input.errorsFixed,
    toolSummary: buildToolSummary(input.record),
    extractedPlan: extractedPlan ?? undefined,
  };
}
