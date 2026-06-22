import type { Event } from "./types.js";
import type { CompileMetrics } from "./compiler.js";
import { buildCrossSessionMemory } from "./compiler.js";

export interface ClassicCompileInput {
  cwd: string;
  sessionId: string;
  toolSchemas: string[];
  agentsContext?: string | null;
  projectContext?: string | null;
  skillsCatalog?: string | null;
  memoryDigest?: string | null;
  events: Event[];
  userInput?: string;
}

function estTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildClassicSystemFrame(
  cwd: string,
  sessionId: string,
  toolSchemas: string[],
  agentsContext?: string | null,
  projectContext?: string | null,
): string {
  const lines = [
    "# System",
    "",
    "You are PRAANA, a coding agent with Cognitive Memory — memory that learns.",
    `Working directory: ${cwd}`,
    `Session ID: ${sessionId}`,
  ];

  if (agentsContext?.trim()) {
    lines.push("", "## Project Context", "", agentsContext.trim());
  }

  if (projectContext?.trim()) {
    lines.push("", "## Project Stack", "", projectContext.trim());
  }

  lines.push(
    "",
    "## Available Tools",
    "",
    ...toolSchemas.map((t) => `- ${t}`),
    "",
    "Use tools when needed to accomplish the user's request. Respond concisely.",
    "",
    "## Skills",
    "",
    "Skills are listed below by name and path. Use read_file on a SKILL.md path when a skill is relevant.",
    "",
    "## Memory",
    "",
    "Use recall() to search Cognitive Memory. Use search_session_log() to search this session's event log.",
    "Session event log file: ~/.praana/sessions/<session_id>/events.jsonl",
    "",
    "## Tool Safety",
    "",
    "RULE: Never call write_file, edit_file, or use shell commands with file write side-effects (e.g. `echo > file`, `sed -i`, `tee`) unless the user's message in THIS turn explicitly requests changes. Describing what you would change does not count. If unsure, ask first.",
  );

  return lines.join("\n");
}

/** Drop the trailing user_message when it duplicates the current turn input. */
export function excludeCurrentUserInputFromEvents(
  events: Event[],
  userInput?: string,
): Event[] {
  if (!userInput?.trim() || events.length === 0) return events;
  const last = events[events.length - 1];
  if (
    last.kind === "user_message" &&
    (last.payload.text as string | undefined) === userInput
  ) {
    return events.slice(0, -1);
  }
  return events;
}

export function buildFullConversationHistory(events: Event[]): string {
  if (events.length === 0) {
    return "# Conversation History\n\n(no prior turns)";
  }

  const lines: string[] = ["# Conversation History"];
  const filtered = events.filter(
    (event) => event.kind !== "context_action" && event.kind !== "system_note",
  );

  let lastToolName: string | undefined;

  for (const event of filtered) {
    switch (event.kind) {
      case "user_message":
        lines.push(`User: ${event.payload.text ?? ""}`);
        break;
      case "agent_message":
        lines.push(`PRAANA: ${event.payload.text ?? ""}`);
        break;
      case "tool_call":
        lastToolName = event.payload.tool as string | undefined;
        lines.push(
          `Tool call: ${lastToolName ?? "unknown"}(${JSON.stringify(event.payload.args ?? {})})`,
        );
        break;
      case "tool_result": {
        const result = event.payload.result;
        const resultStr =
          typeof result === "string" ? result : JSON.stringify(result ?? null);
        const toolName =
          (event.payload.tool as string | undefined) ?? lastToolName ?? "unknown";
        lines.push(`Result (${toolName}): ${resultStr}`);
        break;
      }
    }
  }

  return lines.join("\n");
}

export function compileClassicWithMetrics(
  input: ClassicCompileInput,
): { prompt: string; metrics: CompileMetrics } {
  const sections: string[] = [];

  const frame = buildClassicSystemFrame(
    input.cwd,
    input.sessionId,
    input.toolSchemas,
    input.agentsContext,
    input.projectContext,
  );
  sections.push(frame);

  let skillsSection = "";
  if (input.skillsCatalog?.trim()) {
    skillsSection = input.skillsCatalog.trim();
    sections.push(skillsSection);
  }

  let crossSection = "";
  if (input.memoryDigest?.trim()) {
    crossSection = buildCrossSessionMemory(input.memoryDigest);
    sections.push(crossSection);
  }

  const history = buildFullConversationHistory(
    excludeCurrentUserInputFromEvents(input.events, input.userInput),
  );
  sections.push(history);

  let currentSection = "";
  if (input.userInput) {
    currentSection = `## Current Input\n\nUser: ${input.userInput}`;
    sections.push(currentSection);
  }

  const fullPrompt = sections.join("\n\n");

  return {
    prompt: fullPrompt,
    metrics: {
      totalTokens: estTokens(fullPrompt),
      systemFrameTokens: estTokens(frame),
      agentsContextTokens: input.agentsContext ? estTokens(input.agentsContext) : 0,
      skillsCatalogTokens: skillsSection ? estTokens(skillsSection) : 0,
      checkpointTokens: 0,
      crossSessionTokens: crossSection ? estTokens(crossSection) : 0,
      activeStateTokens: 0,
      peripheralStubsTokens: 0,
      recentTurnsTokens: estTokens(history),
      currentInputTokens: estTokens(currentSection),
      activeObjectCount: 0,
      peripheralObjectCount: 0,
      recentTurnsTruncated: false,
      memoryTruncated: false,
      agentsContextTruncated: false,
      skillsTruncated: false,
    },
  };
}
