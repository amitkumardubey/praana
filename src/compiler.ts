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
}

/** Build a deterministic prompt from structured state. */
export function compile(input: CompileInput): string {
  const sections: string[] = [];

  // ---- 1. SYSTEM FRAME ----
  const frame = buildSystemFrame(
    input.cwd,
    input.sessionId,
    input.toolSchemas
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
  const recent = buildRecentTurns(input.recentEvents);
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
  toolSchemas: string[]
): string {
  return [
    "# System",
    "",
    "You are ARIA, a coding agent with persistent memory.",
    `Working directory: ${cwd}`,
    `Session ID: ${sessionId}`,
    "",
    "## Available Tools",
    "",
    ...toolSchemas.map((t) => `- ${t}`),
    "",
    "Use tools when needed to accomplish the user's request. Respond concisely.",
  ].join("\n");
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

function buildRecentTurns(events: Event[]): string {
  if (events.length === 0) {
    return "# Recent Turns\n\n(no recent events)";
  }

  const lines: string[] = ["# Recent Turns"];
  const filtered = events.filter(
    (e) => e.kind !== "context_action" && e.kind !== "system_note"
  );

  for (const ev of filtered) {
    switch (ev.kind) {
      case "user_message":
        lines.push(`User: ${ev.payload.text ?? ""}`);
        break;
      case "agent_message": {
        const text = truncateText(ev.payload.text, 2000);
        lines.push(`ARIA: ${text}`);
        break;
      }
      case "tool_call":
        lines.push(
          `Tool call: ${ev.payload.tool ?? "unknown"}(${JSON.stringify(ev.payload.args ?? {})})`
        );
        break;
      case "tool_result": {
        const result = ev.payload.result;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        lines.push(`Result: ${truncateText(resultStr, 500)}`);
        break;
      }
    }
  }

  return lines.join("\n");
}

// ---- Helpers ----

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