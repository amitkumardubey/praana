import type { Event, StateObject, TaskPayload, DecisionPayload } from "./types.js";
import type { StateGraph } from "./state-graph.js";
import { getAppLogger } from "./logger.js";

export interface CompileInput {
  stateGraph: StateGraph;
  memoryDigest: string | null;
  recentEvents: Event[];
  userInput?: string;
  toolSchemas: string[];
  cwd: string;
  sessionId: string;
  tokenBudget: number;
  recentTurnsTokenBudget?: number;
  agentsContext?: string | null;
  skillsPromptSection?: string | null;
  checkpointSection?: string | null;
  memoriesBudgetRatio?: number;
  agentsBudgetRatio?: number;
  skillsSectionBudgetRatio?: number;
  reservedOutputTokens?: number;
}

/** Token-estimate metrics per section, emitted for eval / observability. */
export interface CompileMetrics {
  totalTokens: number;
  systemFrameTokens: number;
  agentsContextTokens: number;  // tokens used by AGENTS.md / project context
  skillsCatalogTokens: number;  // tokens used by skills section in prompt
  checkpointTokens: number;
  crossSessionTokens: number;
  activeStateTokens: number;
  peripheralStubsTokens: number;
  recentTurnsTokens: number;
  currentInputTokens: number;
  activeObjectCount: number;
  peripheralObjectCount: number;
  /** If true, some recent turns were truncated due to budget. */
  recentTurnsTruncated: boolean;
  /** If true, Cognitive Memory was trimmed to section ceiling. */
  memoryTruncated: boolean;
  /** If true, project context was degraded to fit agents budget. */
  agentsContextTruncated: boolean;
  /** If true, skills section was trimmed to section ceiling. */
  skillsTruncated: boolean;
}

/** Estimate token count from character count. 1 token ≈ 4 chars is rough but consistent. */
function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Build a deterministic prompt from structured state. */
export function compile(input: CompileInput): string {
  const sections: string[] = [];

  // Generate state summary for system prompt
  const stateSummary = buildStateSummary(input.stateGraph);

  // ---- 1. SYSTEM FRAME ----
  const frame = buildSystemFrame(
    input.cwd,
    input.sessionId,
    input.toolSchemas,
    stateSummary,
    input.agentsContext
  );
  sections.push(frame);

  // ---- 1b. SKILLS ----
  if (input.skillsPromptSection) {
    sections.push(input.skillsPromptSection);
  }

  // ---- 2. CROSS-SESSION MEMORY ----
  if (input.memoryDigest && input.memoryDigest.trim()) {
    const cs = buildCrossSessionMemory(input.memoryDigest);
    sections.push(cs);
  }

  // ---- 3. ACTIVE STATE ----
  const active = buildActiveState(input.stateGraph);
  sections.push(active);

  // ---- 4. PERIPHERAL STUBS ----
  const peripheral = buildPeripheralStubs(input.stateGraph);
  if (peripheral) {
    sections.push(peripheral);
  }

  // ---- 5. RECENT TURNS ----
  // Use token-based limiting for Recent Turns if recentTurnsTokenBudget is provided
  const recentTurnsBudget = input.recentTurnsTokenBudget ?? Math.floor(input.tokenBudget * 0.3); // Default: 30% of total budget
  const recent = buildRecentTurns(input.recentEvents, recentTurnsBudget);
  sections.push(recent);

  // ---- 6. CURRENT INPUT ----
  if (input.userInput) {
    const current = `## Current Input\n\nUser: ${input.userInput}`;
    sections.push(current);
  }

  const fullPrompt = sections.join("\n\n");

  // Token budget check
  const estimatedTokens = estTokens(fullPrompt);
  if (estimatedTokens > input.tokenBudget) {
    getAppLogger().child("compiler").warn(
      `Prompt estimated at ${estimatedTokens} tokens, exceeds budget of ${input.tokenBudget}. Consider trimming.`,
    );
  }

  return fullPrompt;
}

/** Compile with detailed token metrics per section. */
export function compileWithMetrics(input: CompileInput): { prompt: string; metrics: CompileMetrics } {
  const sections: string[] = [];
  const metrics: Partial<CompileMetrics> = {};

  const reservedOutput = input.reservedOutputTokens ?? 0;
  const usable = Math.max(0, input.tokenBudget - reservedOutput);
  const maxMemoryTokens = Math.floor(usable * (input.memoriesBudgetRatio ?? 0.2));
  const maxAgentsTokens = Math.floor(usable * (input.agentsBudgetRatio ?? 0.3));
  const maxSkillsSectionTokens = Math.floor(usable * (input.skillsSectionBudgetRatio ?? 0.2));

  const stateSummary = buildStateSummary(input.stateGraph);

  const { text: agentsContext, truncated: agentsTruncated } = trimAgentsContext(
    input.agentsContext,
    maxAgentsTokens,
  );
  metrics.agentsContextTruncated = agentsTruncated;

  // 1. SYSTEM FRAME
  const frame = buildSystemFrame(input.cwd, input.sessionId, input.toolSchemas, stateSummary, agentsContext);
  sections.push(frame);
  metrics.systemFrameTokens = estTokens(frame);
  metrics.agentsContextTokens = agentsContext ? estTokens(agentsContext) : 0;

  // 1b. SKILLS (progressive disclosure)
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

  // 1c. SESSION CHECKPOINT
  let checkpointSection = "";
  if (input.checkpointSection?.trim()) {
    checkpointSection = input.checkpointSection.trim();
    sections.push(checkpointSection);
  }
  metrics.checkpointTokens = checkpointSection ? estTokens(checkpointSection) : 0;

  // 2. CROSS-SESSION MEMORY
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

  // 3. ACTIVE STATE
  const active = buildActiveState(input.stateGraph);
  sections.push(active);
  metrics.activeStateTokens = estTokens(active);
  metrics.activeObjectCount = input.stateGraph.getActive().length;

  // 4. PERIPHERAL STUBS
  const peripheral = buildPeripheralStubs(input.stateGraph);
  if (peripheral) {
    sections.push(peripheral);
    metrics.peripheralStubsTokens = estTokens(peripheral);
    metrics.peripheralObjectCount = input.stateGraph.getPeripheral().length;
  } else {
    metrics.peripheralStubsTokens = 0;
    metrics.peripheralObjectCount = 0;
  }

  // 5. RECENT TURNS
  const recentTurnsBudget = input.recentTurnsTokenBudget ?? Math.floor(input.tokenBudget * 0.3);
  const { text: recentText, truncated } = buildRecentTurnsWithTruncationFlag(input.recentEvents, recentTurnsBudget);
  sections.push(recentText);
  metrics.recentTurnsTokens = estTokens(recentText);
  metrics.recentTurnsTruncated = truncated;

  // 6. CURRENT INPUT
  let currentSection = "";
  if (input.userInput) {
    currentSection = `## Current Input\n\nUser: ${input.userInput}`;
    sections.push(currentSection);
  }
  metrics.currentInputTokens = estTokens(currentSection);

  const fullPrompt = sections.join("\n\n");
  metrics.totalTokens = estTokens(fullPrompt);

  if (metrics.totalTokens > input.tokenBudget) {
    getAppLogger().child("compiler").warn(
      `Prompt estimated at ${metrics.totalTokens} tokens, exceeds budget of ${input.tokenBudget}.`,
    );
  }

  return { prompt: fullPrompt, metrics: metrics as CompileMetrics };
}

// ---- Section builders ----

export function buildSystemFrame(
  cwd: string,
  sessionId: string,
  toolSchemas: string[],
  stateSummary?: string,
  agentsContext?: string | null
): string {
  const lines = [
    "# System",
    "",
    "You are PRAANA, a coding agent with Cognitive Memory — memory that learns.",
    `Working directory: ${cwd}`,
    `Session ID: ${sessionId}`,
  ];

  if (agentsContext && agentsContext.trim()) {
    lines.push("", "## Project Context", "", agentsContext.trim());
  }

  if (stateSummary) {
    lines.push("", "## Working Memory Status", "", stateSummary);
  }

  lines.push(
    "",
    "## Available Tools",
    "",
    ...toolSchemas.map((t) => `- ${t}`),
    "",
    "Use tools when needed to accomplish the user's request. Respond concisely.",
    "",
    "## Evidence-First Assertions",
    "",
    "Before stating how the codebase works — especially negative claims like \"X is not implemented\" — follow this checklist:",
    "1. Scan Active State notes and constraints for relevant keywords.",
    "2. Scan Recent Turns for prior read_file/shell tool results about that topic.",
    "3. If evidence is missing or stale, call search_session_log or re-read the source.",
    "4. Only assert after you have explicit evidence from this repository context.",
    "",
    "## Implicit Knowledge Capture",
    "",
    "When the user mentions a preference, convention, or project fact without explicitly",
    "requesting a state object, capture it proactively. This is critical for long sessions",
    "where casual remarks get lost after a few turns. Examples:",
    "- User says \"let's use pnpm\" → call add_constraint(\"Use pnpm for package management\")",
    "- User says \"not npm, pnpm\" → call add_constraint(\"Use pnpm, not npm\")",
    "- User corrects you → call add_note(\"User corrected X to Y\")",
    "- User mentions a convention → call add_constraint",
    "- User says \"I prefer\" / \"let's do\" / \"how about\" / \"we always\" → call add_constraint",
    "- User says \"never\" / \"don't\" / \"make sure\" → call add_constraint",
    "Don't over-capture trivial remarks. Capture anything that would prevent a future mistake.",
    "",
    "## Memory Management",
    "",
    "You have working memory with three tiers: active (full content), soft (one-line stub), and hard (minimal anchor).",
    "Periodically call soft_unload on stale notes/tasks and complete_task when work is done to keep your working memory clean.",
    "To recover earlier content from this session (reviews, findings, tool output), use search_session_log — not recall (recall searches Cognitive Memory, the cross-session SQLite layer).",
    "After significant analysis, call add_note immediately so key findings survive when recent turns scroll out of the prompt.",
    "Notes must capture semantic findings (what you learned), not activity logs (which files you read).",
    "Good note: \"turn.ts uses piStream() for streaming — streaming IS implemented\". Bad note: \"read turn.ts, session.ts...\".",
    "Session event log file: ~/.praana/sessions/<session_id>/events.jsonl",
    "See the Active State and Peripheral Memory sections below for your current working memory.",
    "",
    "## Tool Safety",
    "",
    "RULE: Never call write_file, edit_file, or use shell commands with file write side-effects (e.g. `echo > file`, `sed -i`, `tee`) unless the user's message in THIS turn explicitly requests changes. Describing what you would change does not count. If unsure, ask first."
  );

  return lines.join("\n");
}

export function buildCrossSessionMemory(digest: string): string {
  return [
    "# Cross-Session Memory",
    "",
    digest,
    "",
    "Use recall('query') to search your knowledge base for more.",
  ].join("\n");
}

export function buildActiveState(stateGraph: StateGraph): string {
  const active = stateGraph.getActive();
  if (active.length === 0) {
    return "# Active State\n\nNo active state.";
  }

  // Group by kind
  const groups = groupByKind(active);
  const lines: string[] = ["# Active State"];

  for (const [kind, objects] of Object.entries(groups)) {
    lines.push("", `## ${capitalizePlural(kind)}`);

    for (const obj of objects) {
      lines.push(renderActiveObject(obj));
    }
  }

  return lines.join("\n");
}

export function buildPeripheralStubs(stateGraph: StateGraph): string | null {
  const peripheral = stateGraph.getPeripheral();
  if (peripheral.length === 0) return null;

  const lines: string[] = ["# Peripheral Memory"];

  for (const obj of peripheral) {
    if (obj.tier === "soft") {
      lines.push(`- ${obj.id} [${obj.kind}]: ${summarizeForStub(obj)}`);
    } else {
      // hard
      lines.push(`- ${obj.id} [${obj.kind}]`);
    }
  }

  lines.push("", "Use hydrate('<id>') to bring any of these into active memory.");
  return lines.join("\n");
}

/**
 * Calculate token savings: compare compact peripheral stubs vs.
 * rendering the same objects in full active form.
 * Returns { compactTokens, fullTokens, savedTokens, savingsRatio }.
 */
export function calculateTokenSavings(stateGraph: StateGraph): {
  compactTokens: number;
  fullTokens: number;
  savedTokens: number;
  savingsRatio: number;
} {
  const peripheral = stateGraph.getPeripheral(); // soft + hard
  if (peripheral.length === 0) {
    return { compactTokens: 0, fullTokens: 0, savedTokens: 0, savingsRatio: 0 };
  }

  // Build how peripherals are actually rendered (stubs)
  const compactLines: string[] = [];
  for (const obj of peripheral) {
    if (obj.tier === "soft") {
      compactLines.push(`- ${obj.id} [${obj.kind}]: ${summarizeForStub(obj)}`);
    } else {
      compactLines.push(`- ${obj.id} [${obj.kind}]`);
    }
  }
  const compact = compactLines.join("\n");
  const compactTokens = estTokens(compact);

  // Build what they would cost if all rendered in full active form
  const fullLines: string[] = [];
  for (const obj of peripheral) {
    fullLines.push(renderActiveObject(obj));
  }
  const full = fullLines.join("\n");
  const fullTokens = estTokens(full);

  const savedTokens = Math.max(0, fullTokens - compactTokens);
  const savingsRatio = fullTokens > 0 ? savedTokens / fullTokens : 0;

  return { compactTokens, fullTokens, savedTokens, savingsRatio };
}

function buildRecentTurns(events: Event[], tokenBudget?: number): string {
  const { text } = buildRecentTurnsWithTruncationFlag(events, tokenBudget);
  return text;
}

function buildRecentTurnsWithTruncationFlag(events: Event[], tokenBudget?: number): { text: string; truncated: boolean } {
  if (events.length === 0) {
    return { text: "# Recent Turns\n\n(no recent events)", truncated: false };
  }

  const lines: string[] = ["# Recent Turns"];
  const filtered = events.filter(
    (e) => e.kind !== "context_action" && e.kind !== "system_note"
  );

  let lastToolName: string | undefined;
  let estimatedTokens = Math.ceil("# Recent Turns".length / 4);
  let truncated = false;

  for (const ev of filtered) {
    let line = "";

    switch (ev.kind) {
      case "user_message":
        line = `User: ${ev.payload.text ?? ""}`;
        break;
      case "agent_message": {
        const text = truncateText(ev.payload.text, 800);
        line = `PRAANA: ${text}`;
        break;
      }
      case "tool_call":
        lastToolName = ev.payload.tool as string | undefined;
        line = `Tool call: ${lastToolName ?? "unknown"}(${JSON.stringify(ev.payload.args ?? {})})`;
        break;
      case "tool_result": {
        const result = ev.payload.result;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        const toolName = (ev.payload.tool as string | undefined) ?? lastToolName;
        const maxLen = getToolResultTruncation(toolName);
        line = `Result: ${truncateText(resultStr, maxLen)}`;
        break;
      }
    }

    if (line) {
      if (tokenBudget) {
        const lineTokens = Math.ceil(line.length / 4);
        if (estimatedTokens + lineTokens > tokenBudget) {
          lines.push("\n... (truncated due to token budget)");
          truncated = true;
          break;
        }
        estimatedTokens += lineTokens;
      }
      lines.push(line);
    }
  }

  return { text: lines.join("\n"), truncated };
}

/** Get truncation limit for tool results based on tool name */
function getToolResultTruncation(toolName?: string): number {
  // Shell results can be longer (500 chars)
  if (toolName === "shell") return 500;
  // write_file and read_file (show) results should be shorter (200 chars)
  if (toolName === "write_file" || toolName === "read_file" || toolName === "show") return 200;
  // Default for other tools
  return 500;
}

// ---- Helpers ----

/** Build a brief summary of working memory state for the system prompt */
export function buildStateSummary(stateGraph: StateGraph): string {
  const active = stateGraph.getActive();
  const peripheral = stateGraph.getPeripheral();

  const activeByKind = groupByKind(active);
  const parts: string[] = [];

  for (const [kind, objects] of Object.entries(activeByKind)) {
    parts.push(`${objects.length} ${kind}(s)`);
  }

  if (peripheral.length > 0) {
    parts.push(`${peripheral.length} in peripheral memory`);
  }

  if (parts.length === 0) {
    return "No working memory objects yet.";
  }

  return `You have ${parts.join(", ")}. Use soft_unload/hard_unload to demote and hydrate to restore.`;
}

type KindGroup = Record<string, StateObject[]>;

function groupByKind(objects: StateObject[]): KindGroup {
  const groups: KindGroup = {};
  for (const obj of objects) {
    const k = obj.kind;
    if (!groups[k]) groups[k] = [];
    groups[k].push(obj);
  }
  return groups;
}

function capitalizePlural(kind: string): string {
  switch (kind) {
    case "task":
      return "Tasks";
    case "decision":
      return "Decisions";
    case "constraint":
      return "Constraints";
    case "note":
      return "Notes";
    default:
      return kind;
  }
}

function renderActiveObject(obj: StateObject): string {
  const focusTag = obj.focused ? "[FOCUS] " : "";
  const prefix = `- ${obj.id} `;
  switch (obj.kind) {
    case "task": {
      const p = obj.payload as TaskPayload;
      let s = `${prefix}${focusTag}[${p.status}] ${p.title}`;
      if (p.description) s += `\n  ${p.description}`;
      return s;
    }
    case "decision": {
      const p = obj.payload as DecisionPayload;
      return `${prefix}${focusTag}${p.summary}\n  Rationale: ${p.rationale}`;
    }
    case "constraint":
    case "note": {
      const text = (obj.payload as { text: string }).text;
      return `${prefix}${focusTag}${text}`;
    }
  }
}

function summarizeForStub(obj: StateObject): string {
  switch (obj.kind) {
    case "task":
      return (obj.payload as TaskPayload).title;
    case "decision":
      return (obj.payload as DecisionPayload).summary;
    case "constraint":
    case "note": {
      const text = (obj.payload as { text: string }).text;
      return text.length > 80 ? text.slice(0, 80) + "..." : text;
    }
  }
}

function truncateText(text: unknown, maxLen: number): string {
  const s = typeof text === "string" ? text : JSON.stringify(text);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}

export function trimSectionToTokenBudget(
  text: string,
  maxTokens: number,
  truncationNote = "memory section truncated to token budget",
): { text: string; truncated: boolean } {
  if (maxTokens <= 0 || estTokens(text) <= maxTokens) {
    return { text, truncated: false };
  }

  const lines = text.split("\n");
  const kept: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    const lineTokens = estTokens(line + "\n");
    if (kept.length > 0 && tokens + lineTokens > maxTokens) {
      kept.push(`... (${truncationNote})`);
      return { text: kept.join("\n"), truncated: true };
    }
    kept.push(line);
    tokens += lineTokens;
  }
  return { text: kept.join("\n"), truncated: false };
}

export function trimAgentsContext(
  agentsContext: string | null | undefined,
  maxTokens: number,
): { text: string | null; truncated: boolean } {
  if (!agentsContext?.trim()) return { text: null, truncated: false };
  const trimmed = agentsContext.trim();
  if (maxTokens <= 0 || estTokens(trimmed) <= maxTokens) {
    return { text: trimmed, truncated: false };
  }

  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  const headings = lines.filter((l) => l.startsWith("#") || l.startsWith("<!--"));
  const summary = headings.slice(0, 5).join("; ") || lines[0]?.slice(0, 120) || "project context";
  const degraded = `[Project context truncated to fit budget] ${summary}`;
  if (estTokens(degraded) <= maxTokens) {
    return { text: degraded, truncated: true };
  }
  return { text: degraded.slice(0, maxTokens * 4), truncated: true };
}
