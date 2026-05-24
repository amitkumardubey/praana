import type { EventLog } from "../event-log.js";
import type { StateGraph } from "../state-graph.js";
import type { AgentKBClient } from "bodha";
import { createMemoryTools } from "./memory.js";
import { createKnowledgeTools } from "./knowledge.js";
import { createSystemTools } from "./system.js";

export interface ToolRegistryContext {
  eventLog: EventLog;
  stateGraph: StateGraph;
  bodhaClient: AgentKBClient | null;
  bodhaEnabled: boolean;
  cwd: string;
}

export function createAllTools(ctx: ToolRegistryContext) {
  const memoryTools = createMemoryTools({
    eventLog: ctx.eventLog,
    stateGraph: ctx.stateGraph,
  });

  const knowledgeTools = createKnowledgeTools({
    bodhaClient: ctx.bodhaClient,
    bodhaEnabled: ctx.bodhaEnabled,
  });

  const systemTools = createSystemTools({
    cwd: ctx.cwd,
  });

  return {
    ...memoryTools,
    ...knowledgeTools,
    ...systemTools,
  };
}

/** Build a human-readable list of tool descriptions for the system prompt. */
export function describeTools(): string[] {
  return [
    "create_task(title, description?) — Create a new task",
    "complete_task(id) — Mark a task as done",
    "add_constraint(text) — Add a constraint",
    "decide(summary, rationale) — Record a decision",
    "add_note(text) — Add a note",
    "soft_unload(id) — Demote object to soft tier",
    "hard_unload(id) — Demote object to hard tier",
    "hydrate(id) — Promote object back to active",
    "list_state() — List all state objects",
    "recall(query, mode?, kinds?) — Search cross-session knowledge base",
    "remember(content, kind?, certainty?) — Store in cross-session knowledge base",
    "shell(command, timeout?) — Execute a shell command",
    "read_file(path, offset?, limit?) — Read a file",
    "write_file(path, content) — Write or overwrite a file",
    "edit_file(path, oldText, newText) — Replace text in a file",
  ];
}
