import type { EventLog } from "../event-log.js";
import type { StateGraph } from "../state-graph.js";
import type { MemoryStore } from "../memory/index.js";
import type { ContextEngine } from "../context-engine/index.js";
import type { ScorecardInc } from "../context-engine/telemetry.js";
import type { SandboxConfig } from "../types.js";
import type { SkillRecord } from "../skills/types.js";
import type { SkillRuntime } from "../skills/index.js";
import { createMemoryTools } from "./memory.js";
import { createKnowledgeTools } from "./knowledge.js";
import { createSystemTools } from "./system.js";
import { createSearchCodeTool } from "./search-code.js";

export interface ToolRegistryContext {
  eventLog: EventLog;
  stateGraph: StateGraph;
  memoryStore: MemoryStore | null;
  memoryEnabled: boolean;
  incognito: boolean;
  contextEngine: ContextEngine | null;
  scorecard?: ScorecardInc;
  onScorecardFileRead?: (absPath: string) => void;
  onScorecardSkillLoad?: (skillId: string, bodyTokens: number) => void;
  classicMode?: boolean;
  cwd: string;
  getAbortSignal?: () => AbortSignal | undefined;
  sandbox?: SandboxConfig;
  editConfirm?: boolean;
  getCurrentTurn?: () => number;
  searchCode?: { rg_path?: string };
  shellLiveStream?: boolean;
  skills: SkillRecord[];
  skillRuntime: SkillRuntime | null;
}

export function createAllTools(ctx: ToolRegistryContext) {
  const classicMode = ctx.classicMode ?? false;

  const memoryTools = createMemoryTools({
    eventLog: ctx.eventLog,
    stateGraph: ctx.stateGraph,
    memoryStore: ctx.memoryStore,
    memoryEnabled: ctx.memoryEnabled,
    incognito: ctx.incognito,
    includeWorkingMemoryTools: !classicMode,
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
    skillScorecard: ctx.scorecard,
    getCurrentTurn: ctx.getCurrentTurn ?? (() => 0),
  });
  const systemTools = createSystemTools({
    cwd: ctx.cwd,
    getAbortSignal: ctx.getAbortSignal,
    sandbox: ctx.sandbox,
    editConfirm: ctx.editConfirm,
    shellLiveStream: ctx.shellLiveStream,
    skills: ctx.skills,
    skillRuntime: ctx.skillRuntime,
    skillScorecard: ctx.scorecard,
    onScorecardFileRead: ctx.onScorecardFileRead,
    onScorecardSkillLoad: ctx.onScorecardSkillLoad,
    getCurrentTurn: ctx.getCurrentTurn ?? (() => 0),
  });
  const searchCodeTools = createSearchCodeTool({
    cwd: ctx.cwd,
    getAbortSignal: ctx.getAbortSignal,
    sandbox: ctx.sandbox,
    rgPath: ctx.searchCode?.rg_path,
  });

  return {
    ...memoryTools,
    ...knowledgeTools,
    ...systemTools,
    ...searchCodeTools,
  };
}

export interface DescribeToolsOptions {
  contextEngineEnabled?: boolean;
  classicMode?: boolean;
}

const WORKING_MEMORY_TOOL_DESCRIPTIONS = [
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
];

const SHARED_TOOL_DESCRIPTIONS = [
  "search_session_log(query, kinds?, limit?) — Search current session event log (not Cognitive Memory recall)",
  "read_and_summarize(path) — Read file and return structured summary (exports, imports, metrics)",
  "recall(query, mode?, kinds?) — Search Cognitive Memory",
  "remember(content, kind?, certainty?, scope?) — Store in Cognitive Memory (kinds: fact, preference, decision, pattern, mistake, constraint)",
  "forget_memory(id) — Retract a Cognitive Memory entry (tombstone)",
  "shell(command, timeout?) — Execute a shell command",
  "read_file(path, offset?, limit?) — Read a file",
  "write_file(path, content) — Write or overwrite a file",
  "edit_file(path, oldText, newText) — Replace text in a file",
  "batch_write(files) — Write multiple files atomically",
  "batch_edit(edits) — Edit multiple files atomically",
  "search_code(pattern, path?, glob?, glob_exclude?, case_insensitive?, context?, max_results?, file_type?, include_hidden?, no_ignore?, multiline?, timeout?) — Structured ripgrep-backed code search (file:line:column matches with context and stats)",
  "load_skill(skill_id) — Load a skill's full instructions from the catalog",
];

const ENGINE_TOOL_DESCRIPTIONS = [
  "search_turn_events(query, limit?) — BM25 search over structured turn ledger",
  'retrieve_artifact(id, grep?, lineStart?, lineEnd?, jsonPath?) — Retrieve full raw content for a stored tool-output artifact',
  "context_summary() — Current session checkpoint, open errors, and recent activity",
  "event_lineage(artifactId) — Trace artifact provenance, related decisions, and linked artifacts/files",
];

/** Build a human-readable list of tool descriptions for the system prompt. */
export function describeTools(options?: DescribeToolsOptions): string[] {
  const classicMode =
    options?.classicMode ?? options?.contextEngineEnabled === false;

  if (classicMode) {
    return [...SHARED_TOOL_DESCRIPTIONS];
  }

  const tools = [...WORKING_MEMORY_TOOL_DESCRIPTIONS, ...SHARED_TOOL_DESCRIPTIONS];

  if (options?.contextEngineEnabled) {
    tools.push(...ENGINE_TOOL_DESCRIPTIONS);
  }

  return tools;
}
