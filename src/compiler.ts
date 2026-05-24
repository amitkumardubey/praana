import type { Event, StateObject, TaskPayload, DecisionPayload } from "./types.js";
import type { StateGraph } from "./state-graph.js";

export interface CompileInput {
  stateGraph: StateGraph;
  bodhaDigest: string | null;
  recentEvents: Event[];
  userInput?: string;
  toolSchemas: string[];
  cwd: string;
  sessionId: string;
  tokenBudget: number;
  recentTurnsTokenBudget?: number; // Optional: token budget specifically for Recent Turns
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
    stateSummary
  );
  sections.push(frame);

  // ---- 2. CROSS-SESSION MEMORY ----
  if (input.bodhaDigest && input.bodhaDigest.trim()) {
    const cs = buildCrossSessionMemory(input.bodhaDigest);
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

  // Token budget check (rough: 1 token ≈ 4 chars)
  const estimatedTokens = Math.ceil(fullPrompt.length / 4);
  if (estimatedTokens > input.tokenBudget) {
    console.warn(
      `[compiler] Prompt estimated at ${estimatedTokens} tokens, exceeds budget of ${input.tokenBudget}. Consider trimming.`
    );
  }

  return fullPrompt;
}

// ---- Section builders ----

function buildSystemFrame(
  cwd: string,
  sessionId: string,
  toolSchemas: string[],
  stateSummary?: string
): string {
  const lines = [
    "# System",
    "",
    "You are ARIA, a coding agent with persistent memory.",
    `Working directory: ${cwd}`,
    `Session ID: ${sessionId}`,
  ];

  // Add state summary if provided
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
    "## Memory Management",
    "",
    "You have working memory with three tiers: active (full content), soft (one-line stub), and hard (minimal anchor).",
    "Periodically call soft_unload on stale notes/tasks and complete_task when work is done to keep your working memory clean.",
    "See the Active State and Peripheral Memory sections below for your current working memory."
  );

  return lines.join("\n");
}

function buildCrossSessionMemory(digest: string): string {
  return [
    "# Cross-Session Memory",
    "",
    digest,
    "",
    "Use recall('query') to search your knowledge base for more.",
  ].join("\n");
}

function buildActiveState(stateGraph: StateGraph): string {
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

function buildPeripheralStubs(stateGraph: StateGraph): string | null {
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

function buildRecentTurns(events: Event[], tokenBudget?: number): string {
  if (events.length === 0) {
    return "# Recent Turns\n\n(no recent events)";
  }

  const lines: string[] = ["# Recent Turns"];
  const filtered = events.filter(
    (e) => e.kind !== "context_action" && e.kind !== "system_note"
  );

  // Track the last tool call to know which tool produced each result
  let lastToolName: string | undefined;
  let estimatedTokens = 0;
  const headerTokens = Math.ceil("# Recent Turns".length / 4);

  for (const ev of filtered) {
    let line = "";

    switch (ev.kind) {
      case "user_message":
        line = `User: ${ev.payload.text ?? ""}`;
        break;
      case "agent_message": {
        const text = truncateText(ev.payload.text, 800); // Reduced from 2000 to 800
        line = `ARIA: ${text}`;
        break;
      }
      case "tool_call":
        lastToolName = ev.payload.tool as string | undefined;
        line = `Tool call: ${lastToolName ?? "unknown"}(${JSON.stringify(ev.payload.args ?? {})})`;
        break;
      case "tool_result": {
        const result = ev.payload.result;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        // Apply different truncation based on tool
        const toolName = (ev.payload.tool as string | undefined) ?? lastToolName;
        const maxLen = getToolResultTruncation(toolName);
        line = `Result: ${truncateText(resultStr, maxLen)}`;
        break;
      }
    }

    if (line) {
      // Check token budget if specified
      if (tokenBudget) {
        const lineTokens = Math.ceil(line.length / 4);
        if (estimatedTokens + lineTokens > tokenBudget) {
          lines.push("\n... (truncated due to token budget)");
          break;
        }
        estimatedTokens += lineTokens;
      }
      lines.push(line);
    }
  }

  return lines.join("\n");
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
function buildStateSummary(stateGraph: StateGraph): string {
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
  const prefix = `- ${obj.id} `;
  switch (obj.kind) {
    case "task": {
      const p = obj.payload as TaskPayload;
      let s = `${prefix}[${p.status}] ${p.title}`;
      if (p.description) s += `\n  ${p.description}`;
      return s;
    }
    case "decision": {
      const p = obj.payload as DecisionPayload;
      return `${prefix}${p.summary}\n  Rationale: ${p.rationale}`;
    }
    case "constraint":
    case "note": {
      const text = (obj.payload as { text: string }).text;
      return `${prefix}${text}`;
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