import type { EventLog } from "../event-log.js";
import type { StateGraph } from "../state-graph.js";
import type { MemoryStore } from "../memory/index.js";
import type { ContextEngine } from "../context-engine/index.js";
import type { SandboxConfig } from "../types.js";
import { createMemoryTools } from "./memory.js";
import { createKnowledgeTools } from "./knowledge.js";
import { createSystemTools } from "./system.js";

export interface ToolRegistryContext {
  eventLog: EventLog;
  stateGraph: StateGraph;
  memoryStore: MemoryStore | null;
  memoryEnabled: boolean;
  incognito: boolean;
  contextEngine: ContextEngine | null;
  cwd: string;
  getAbortSignal?: () => AbortSignal | undefined;
  sandbox?: SandboxConfig;
  editConfirm?: boolean;
  getCurrentTurn?: () => number;
}

export function createAllTools(ctx: ToolRegistryContext) {
  const memoryTools = createMemoryTools({
    eventLog: ctx.eventLog,
    stateGraph: ctx.stateGraph,
    searchTurnEvents: ctx.contextEngine
      ? (query, limit, currentTurn) =>
          ctx.contextEngine!.searchTurnEvents(
            query,
            limit,
            currentTurn ?? ctx.getCurrentTurn?.() ?? 0,
          )
      : undefined,
  });

  const knowledgeTools = createKnowledgeTools({
    eventLog: ctx.eventLog,
    memoryStore: ctx.memoryStore,
    memoryEnabled: ctx.memoryEnabled,
    incognito: ctx.incognito,
    contextEngine: ctx.contextEngine,
    getCurrentTurn: ctx.getCurrentTurn ?? (() => 0),
  });
  const systemTools = createSystemTools({
    cwd: ctx.cwd,
    getAbortSignal: ctx.getAbortSignal,
    sandbox: ctx.sandbox,
    editConfirm: ctx.editConfirm,
  });

  return {
    ...memoryTools,
    ...knowledgeTools,
    ...systemTools,
  };
}

export interface DescribeToolsOptions {
  contextEngineEnabled?: boolean;
}

/** Build a human-readable list of tool descriptions for the system prompt. */
export function describeTools(options?: DescribeToolsOptions): string[] {
  const tools = [
    "create_task(title, description?) — Create a new task",
    "complete_task(id) — Mark a task as done",
    "retract_task(id) — Retract a task/object from working memory (tombstone)",
    "add_constraint(text) — Add a constraint",
    "decide(summary, rationale) — Record a decision",
    "add_note(text) — Add a note",
    "soft_unload(id) — Demote object to soft tier",
    "hard_unload(id) — Demote object to hard tier",
    "hydrate(id) — Promote object back to active",
    "list_state() — List all state objects",
    "focus_task(id) — Pin a task/object as current focus",
    "search_session_log(query, kinds?, limit?) — Search current session event log (not cross-session recall)",
    "read_and_summarize(path) — Read file and return structured summary (exports, imports, metrics)",
    "recall(query, mode?, kinds?) — Search cross-session memory",
    "remember(content, kind?, certainty?, scope?) — Store in cross-session memory (kinds: fact, preference, decision, pattern, mistake, constraint)",
    "forget_memory(id) — Retract a cross-session memory entry (tombstone)",
    "shell(command, timeout?) — Execute a shell command",
    "read_file(path, offset?, limit?) — Read a file",
    "write_file(path, content) — Write or overwrite a file",
    "edit_file(path, oldText, newText) — Replace text in a file",
    "batch_write(files) — Write multiple files atomically",
    "batch_edit(edits) — Edit multiple files atomically",
  ];

  if (options?.contextEngineEnabled) {
    tools.push(
      "search_turn_events(query, limit?) — BM25 search over structured turn ledger",
      'retrieve_artifact(id, grep?, lineStart?, lineEnd?, jsonPath?) — Retrieve full raw content for a stored tool-output artifact',
      "context_summary() — Current session checkpoint, open errors, and recent activity",
      "event_lineage(artifactId) — Trace artifact provenance, related decisions, and linked artifacts/files",
    );
  }

  return tools;
}
