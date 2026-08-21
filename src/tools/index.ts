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
import { createGitTools } from "./git.js";
import { createCodeIntelTools } from "./code-intel.js";
import { createLspTools } from "./lsp.js";
import type { LspManager } from "../lsp/manager.js";

export interface ToolRegistryContext {
  eventLog: EventLog;
  stateGraph: StateGraph;
  memoryStore: MemoryStore | null;
  memoryEnabled: boolean;
  incognito: boolean;
  contextEngine: ContextEngine | null;
  scorecard?: ScorecardInc;
  onScorecardFileRead?: (absPath: string, mtimeMs?: number, countAsRepeat?: boolean) => void;
  onScorecardSkillLoad?: (skillId: string, bodyTokens: number) => void;
  classicMode?: boolean;
  cwd: string;
  getAbortSignal?: () => AbortSignal | undefined;
  sandbox?: SandboxConfig;
  editConfirm?: boolean;
  getCurrentTurn?: () => number;
  getLastResetBoundaryTurn?: () => number;
  searchCode?: { rg_path?: string };
  shellLiveStream?: boolean;
  skills: SkillRecord[];
  skillRuntime: SkillRuntime | null;
  blockRepeatReads?: boolean;
  hasReadPath?: (absPath: string) => boolean;
  getReadPathMtime?: (absPath: string) => number | undefined;
  clearReadPath?: (absPath: string) => void;
  findFileReadArtifact?: (absPath: string) => {
    id: string;
    createdTurn: number;
    card: string;
  } | null;
  findFileReadArtifactByRange?: (
    absPath: string,
    offset?: number,
    limit?: number,
  ) => {
    id: string;
    createdTurn: number;
    card: string;
  } | null;
  lspManager?: LspManager | null;
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
            ctx.getLastResetBoundaryTurn?.() ?? -1,
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
    getLastResetBoundaryTurn: ctx.getLastResetBoundaryTurn,
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
    blockRepeatReads: ctx.blockRepeatReads,
    hasReadPath: ctx.hasReadPath,
    getReadPathMtime: ctx.getReadPathMtime,
    clearReadPath: ctx.clearReadPath,
    findFileReadArtifact: ctx.findFileReadArtifact,
    findFileReadArtifactByRange: ctx.findFileReadArtifactByRange,
  });
  const searchCodeTools = createSearchCodeTool({
    cwd: ctx.cwd,
    getAbortSignal: ctx.getAbortSignal,
    sandbox: ctx.sandbox,
    rgPath: ctx.searchCode?.rg_path,
  });
  const gitTools = createGitTools({
    cwd: ctx.cwd,
    editConfirm: ctx.editConfirm,
    sandbox: ctx.sandbox,
    getAbortSignal: ctx.getAbortSignal,
  });
  const codeIntelTools = createCodeIntelTools({
    cwd: ctx.cwd,
    sandbox: ctx.sandbox,
  });
  const lspTools = createLspTools({
    cwd: ctx.cwd,
    sandbox: ctx.sandbox,
    getLsp: () => ctx.lspManager ?? null,
    clearReadPath: ctx.clearReadPath,
  });

  return {
    ...memoryTools,
    ...knowledgeTools,
    ...systemTools,
    ...searchCodeTools,
    ...gitTools,
    ...codeIntelTools,
    ...lspTools,
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
  "git_status() — Structured git working-tree status (branch, ahead/behind, staged/unstaged/untracked/conflicted)",
  "git_diff(staged?, path?, context?) — Structured git diff with files, hunks, and stats",
  "git_commit(message, paths?, all?) — Create a git commit with guardrails (blocked in plan mode; does not push)",
  "code_parse(path, language?) — Tree-sitter syntax diagnostics (TS/JS/Python/Go)",
  "code_imports(path, language?) — Structured imports for a source file",
  "code_symbols(path, language?) — Top-level / exported symbols for a source file",
  "code_definition(symbol, root?, language?, max_files?, max_hits?) — Name-based definition hits under a project root",
  "code_references(symbol, root?, language?, max_files?, max_hits?) — Name-based reference hits under a project root",
  "lsp_diagnostics(path) — LSP diagnostics for a file (requires [lsp] enabled + configured server)",
  "lsp_format(path) — Format a file via LSP (mutating; requires [lsp] enabled + configured server)",
  "lsp_hover(path, line, col) — LSP type/docs at a 1-based position (requires [lsp]; use code_* for fast name queries)",
  "lsp_completions(path, line, col) — Up to 20 LSP completion labels at a position (no insert)",
  "lsp_definition(path, line, col) — Semantic LSP definition at a position (stdlib/deps); code_definition is name-based in-project",
  "lsp_references(path, line, col) — Semantic LSP references at a position; code_references is name-based in-project",
  "lsp_code_actions(path, startLine, startCol, endLine, endCol) — List applicable LSP quick fixes (opaque ids)",
  "lsp_apply_code_action(id) — Apply a listed code action (text edits only; mutating)",
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
