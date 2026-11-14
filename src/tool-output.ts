/**
 * Deterministic tool-output ingestion shaper and stub planner.
 *
 * 1. Ingestion shaping (`shapeToolOutput`): runs once when a tool result enters
 *    the log. Results over `inlineThresholdTokens` keep bounded head and tail
 *    lines/bytes with an elision marker naming the side-file artifact ID
 *    (`retrieve_artifact`). Inputs whose exact bytes the model must reproduce
 *    (`read_file`, LSP location tools, `retrieve_artifact`) are never shaped.
 * 2. Result stubbing (`buildToolResultStub`, `planToolResultStubs`):
 *    provides a `StubPlanner` for compaction, replacing eligible large tool
 *    results with a single-line stub carrying the canonical event ID (and
 *    artifact ID when present).
 */

import type { StubCandidate, StubEntry, StubPlanner } from "./compaction.js";
import { estimateTokens } from "./token-estimate.js";
import { detectShellReads } from "./tools/shell-read-detect.js";

export type { StubCandidate, StubEntry, StubPlanner };
export { DEFAULT_STUB_KEEP_RECENT, DEFAULT_STUB_MIN_TOKENS } from "./compaction.js";

export const DEFAULT_INLINE_THRESHOLD_TOKENS = 400;
export const DEFAULT_SHAPE_MAX_LINES = 80;
export const DEFAULT_SHAPE_HEAD_LINES = 40;
export const DEFAULT_SHAPE_TAIL_LINES = 40;
export const DEFAULT_SHAPE_MAX_BYTES = 8192;
export const DEFAULT_SHAPE_HEAD_BYTES = 4096;
export const DEFAULT_SHAPE_TAIL_BYTES = 4096;

export type ToolOutputClassification = "exact-bytes" | "shapeable";

/**
 * Explicit classification for every registered tool (`createAllTools`).
 * Unclassified tools default to `"exact-bytes"` so new tools are never shaped by accident.
 *
 * `shell` and `web_fetch` are classified as `"shapeable"` by design because they
 * return bulk free-form output; when shaped, the elision marker instructs the model
 * to call `retrieve_artifact` to inspect omitted sections. Note that shaping can
 * cut IDs or file paths printed by shell commands that are not recognised as file
 * reads, whereas the dedicated tools (`git_log`, `git_diff`, `find_files`,
 * `search_code`) are `"exact-bytes"` and are always preserved verbatim at ingestion.
 */
export const TOOL_OUTPUT_CLASSIFICATION: Readonly<Record<string, ToolOutputClassification>> =
  Object.freeze({
    // Working memory & session log tools (src/tools/memory.ts)
    create_task: "exact-bytes", // Returns state object id copied into task/state mutation calls.
    complete_task: "exact-bytes", // Small status ack or error message; never bulk output.
    retract_task: "exact-bytes", // Small status ack or error message; never bulk output.
    add_constraint: "exact-bytes", // Returns state and memory ids copied into follow-up calls.
    decide: "exact-bytes", // Returns state and memory ids copied into follow-up calls.
    add_note: "exact-bytes", // Returns state object id and warning metadata; never bulk output.
    soft_unload: "exact-bytes", // Small status ack or error message; never bulk output.
    hard_unload: "exact-bytes", // Small status ack or error message; never bulk output.
    hydrate: "exact-bytes", // Restores exact stored state object payload on demand.
    list_state: "exact-bytes", // Returns state object ids, kinds, and tiers for state mutations.
    focus_task: "exact-bytes", // Returns focused state object id; never bulk output.
    search_session_log: "exact-bytes", // Returns event_ids and artifact ids copied into follow-up lookups.

    // Knowledge & artifact tools (src/tools/knowledge.ts)
    recall: "exact-bytes", // Returns Cognitive Memory entries with ids needed for forget_memory.
    remember: "exact-bytes", // Returns created or reinforced memory id for later reference.
    forget_memory: "exact-bytes", // Small status ack carrying memory id; never bulk output.
    search_turn_events: "exact-bytes", // Returns turn summaries with artifactIds and file paths.
    context_summary: "exact-bytes", // Bounded checkpoint summary of active intent, decisions, and errors.
    retrieve_artifact: "exact-bytes", // Explicit raw artifact retrieval; caller requested exact bytes.
    event_lineage: "exact-bytes", // Returns artifact ids, turn ids, and file paths in lineage graph.

    // Transcript search (src/tools/search-transcript.ts)
    search_transcript: "exact-bytes", // Returns canonical event/artifact ids and exact fetched message text.

    // System & file tools (src/tools/system.ts)
    shell: "shapeable", // Free-form bulk stdout/stderr from arbitrary shell commands.
    read_file: "exact-bytes", // Source bytes copied verbatim into edit_file/batch_edit oldText.
    read_and_summarize: "exact-bytes", // Structured JSON with exact path, exported symbol names, and preview lines.
    load_skill: "exact-bytes", // Skill instructions whose exact commands and rules must stay intact.
    write_file: "exact-bytes", // Small write confirmation metadata; never bulk output.
    edit_file: "exact-bytes", // Small edit confirmation metadata; never bulk output.
    batch_write: "exact-bytes", // Structured list of written file paths; confirmation metadata.
    batch_edit: "exact-bytes", // Structured list of edited file paths; confirmation metadata.

    // Code & file search tools (src/tools/search-code.ts, src/tools/find-files.ts)
    search_code: "exact-bytes", // Structured JSON matches with file, line, column, and text for edits.
    find_files: "exact-bytes", // Structured JSON file paths copied into read_file/edit_file/lsp_* calls.

    // Git tools (src/tools/git.ts)
    git_status: "exact-bytes", // Structured JSON lists of exact staged/unstaged/untracked/conflicted paths.
    git_diff: "exact-bytes", // Carries file paths, line numbers, and diff hunks; large diffs already use artifacts with stub cards.
    git_commit: "exact-bytes", // Small commit ack with sha, summary, and committed paths.
    git_branches: "exact-bytes", // Structured branch names, upstreams, and commit refs.
    git_log: "exact-bytes", // Carries commit shas, file paths, and summaries reused in follow-up calls.

    // Tree-sitter code intelligence tools (src/tools/code-intel.ts)
    code_parse: "exact-bytes", // Syntax diagnostic positions (line/column/path) for locating edits.
    code_imports: "exact-bytes", // Structured import specifiers and file path.
    code_symbols: "exact-bytes", // Structured symbol names and line ranges for locating edits.
    code_definition: "exact-bytes", // Exact definition file paths and line/column positions.
    code_references: "exact-bytes", // Exact reference file paths and line/column positions.

    // LSP tools (src/tools/lsp.ts)
    lsp_diagnostics: "exact-bytes", // Exact file path and line/column diagnostics for edits.
    lsp_format: "exact-bytes", // Small format ack with path and changed flag.
    lsp_hover: "exact-bytes", // Type signature and docs at a single cursor position.
    lsp_completions: "exact-bytes", // Exact completion labels inserted verbatim into code.
    lsp_definition: "exact-bytes", // Exact definition file paths and line/column positions.
    lsp_references: "exact-bytes", // Exact reference file paths and line/column positions.
    lsp_code_actions: "exact-bytes", // Returns opaque action ids passed verbatim to lsp_apply_code_action.
    lsp_apply_code_action: "exact-bytes", // Small ack listing modified file paths.

    // Test runner & web fetch (src/tools/run-tests.ts, src/tools/web/tool.ts)
    run_tests: "exact-bytes", // Carries structured pass/fail counts, file paths, line numbers, and failure excerpts.
    web_fetch: "shapeable", // Free-form bulk markdown/text fetched from web pages.
  });

/**
 * Tools whose output the model must reproduce verbatim (`edit_file` targets,
 * LSP diagnostic/symbol locations, or explicit artifact retrievals).
 */
export const DEFAULT_EXACT_BYTES_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(TOOL_OUTPUT_CLASSIFICATION)
    .filter(([, policy]) => policy === "exact-bytes")
    .map(([name]) => name),
);

/** Shared artifact ID token grammar used by marker formatting and extraction. */
const ARTIFACT_ID_GRAMMAR = "[A-Za-z0-9][A-Za-z0-9_.:/-]*";
/**
 * Maximum accepted artifact ID length (in ASCII characters/bytes).
 * Reserved during worst-case marker sizing so a valid stored ID never pushes
 * an already-fitted candidate over `maxBytes`.
 */
const MAX_ARTIFACT_ID_LENGTH = 64;
const RESERVED_ARTIFACT_ID = "a".repeat(MAX_ARTIFACT_ID_LENGTH);
const ARTIFACT_ID_EXACT_RE = new RegExp(`^${ARTIFACT_ID_GRAMMAR}$`);
const ELIDED_MARKER_LINE_RE = new RegExp(
  `^\\.\\.\\. \\[elided (?:[1-9]\\d* lines? / )?\\d+ bytes(?: \\(partial lines at cut truncated\\))?; full output stored in artifact (${ARTIFACT_ID_GRAMMAR}) — call retrieve_artifact\\("\\1"\\) to inspect\\] \\.\\.\\.$`,
);
const CARD_WHOLE_TEXT_RE = new RegExp(
  `^\\[artifact:\\s*(${ARTIFACT_ID_GRAMMAR})\\s*\\|[^\\n]*\\](?:\\nRetrieve: retrieve_artifact\\("\\1"\\))?$`,
);

export interface ShapeToolOutputOptions {
  inlineThresholdTokens: number;
  maxLines: number;
  headLines: number;
  tailLines: number;
  maxBytes: number;
  headBytes: number;
  tailBytes: number;
  exactBytesTools?: ReadonlySet<string> | readonly string[];
}

export type ArtifactStoreCallback = (
  rawText: string,
) => { artifactId?: string | null } | string | null | undefined;

export interface ShapeToolOutputInput {
  toolName: string;
  text: string;
  command?: string;
  isError?: boolean;
  preserveExactBytes?: boolean;
  artifactId?: string;
  storeArtifact?: ArtifactStoreCallback;
  options?: Partial<ShapeToolOutputOptions>;
}

export interface ShapeToolOutputResult {
  text: string;
  shaped: boolean;
  artifactId?: string;
  rawTokens: number;
  shapedTokens: number;
  omittedLines: number;
  omittedBytes: number;
}

function resolveShapeOptions(
  options: Partial<ShapeToolOutputOptions> = {},
): ShapeToolOutputOptions {
  const inlineThresholdTokens =
    options.inlineThresholdTokens ?? DEFAULT_INLINE_THRESHOLD_TOKENS;
  const maxLines = options.maxLines ?? DEFAULT_SHAPE_MAX_LINES;
  const headLines = options.headLines ?? Math.floor(maxLines / 2);
  const tailLines = options.tailLines ?? maxLines - headLines;
  const maxBytes = options.maxBytes ?? DEFAULT_SHAPE_MAX_BYTES;
  const headBytes = options.headBytes ?? Math.floor(maxBytes / 2);
  const tailBytes = options.tailBytes ?? maxBytes - headBytes;
  return {
    inlineThresholdTokens,
    maxLines,
    headLines,
    tailLines,
    maxBytes,
    headBytes,
    tailBytes,
    exactBytesTools: options.exactBytesTools,
  };
}

const SHELL_READER_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "nl",
  "awk",
  "less",
  "more",
  "bat",
  "rg",
  "grep",
]);

const GIT_READ_CONTENT_SUBCOMMANDS = new Set(["show", "diff", "log", "blame"]);
const GIT_VALUE_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--super-prefix",
  "--config-env",
]);

function splitShellCommandSegments(command: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "\\") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    const next = command[i + 1] ?? "";
    if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
      segments.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "\r") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }

  // Fail closed on unterminated quotes or trailing escape.
  if (quote !== null || escaped) return null;
  segments.push(current);
  return segments;
}

function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < segment.length) {
    while (i < segment.length && /\s/.test(segment[i] ?? "")) i++;
    if (i >= segment.length) break;
    let token = "";
    while (i < segment.length && !/\s/.test(segment[i] ?? "")) {
      const ch = segment[i] ?? "";
      if (ch === "'" || ch === '"') {
        const q = ch;
        i++;
        while (i < segment.length && segment[i] !== q) {
          if (q === '"' && segment[i] === "\\" && i + 1 < segment.length) {
            i++;
          }
          token += segment[i] ?? "";
          i++;
        }
        if (i < segment.length && segment[i] === q) i++;
      } else if (ch === "\\" && i + 1 < segment.length) {
        i++;
        token += segment[i] ?? "";
        i++;
      } else {
        token += ch;
        i++;
      }
    }
    if (token.length > 0) tokens.push(token);
  }
  return tokens;
}

function isSedPrintSegment(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") break;
    if (arg === "-n" || arg === "--quiet" || arg === "--silent") return true;
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("n")) {
      return true;
    }
  }
  return false;
}

function isGitReadContentSegment(args: readonly string[]): boolean {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (!arg) break;
    if (arg === "--") {
      i++;
      break;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (GIT_VALUE_FLAGS.has(arg) && !arg.includes("=")) {
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    return GIT_READ_CONTENT_SUBCOMMANDS.has(arg);
  }
  return false;
}

function isSegmentFileRead(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed) return false;
  if (detectShellReads(trimmed) !== null) return true;

  const tokens = tokenizeShellSegment(trimmed);
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx] ?? "";
    if (tok === "!" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      idx++;
      continue;
    }
    const bareTok = tok.includes("/") ? (tok.split("/").pop() ?? tok) : tok;
    if (bareTok === "env" || bareTok === "command" || bareTok === "exec") {
      idx++;
      while (idx < tokens.length && (tokens[idx] ?? "").startsWith("-")) idx++;
      continue;
    }
    break;
  }

  const cmdToken = tokens[idx];
  if (!cmdToken) return false;

  const bare = cmdToken.includes("/") ? (cmdToken.split("/").pop() ?? cmdToken) : cmdToken;
  const args = tokens.slice(idx + 1);

  if (SHELL_READER_COMMANDS.has(bare)) return true;
  if (bare === "sed" && isSedPrintSegment(args)) return true;
  if (bare === "git" && isGitReadContentSegment(args)) return true;
  return false;
}

function isShapeableShellCommand(command: unknown): boolean {
  if (typeof command !== "string" || command.trim().length === 0) return false;
  const segments = splitShellCommandSegments(command);
  if (!segments) return false;
  let hasCommand = false;
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    hasCommand = true;
    if (isSegmentFileRead(trimmed)) return false;
  }
  return hasCommand;
}

function isExactBytesTool(
  toolName: string,
  custom?: ReadonlySet<string> | readonly string[],
): boolean {
  if (custom && ("has" in custom ? custom.has(toolName) : custom.includes(toolName))) {
    return true;
  }
  // Unclassified tools are treated as exact-bytes so they are never shaped by accident.
  return TOOL_OUTPUT_CLASSIFICATION[toolName] !== "shapeable";
}

function sliceHeadByUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return "";
  let endIdx = maxBytes + 4;
  let window = text;
  if (text.length > endIdx) {
    const lastCode = text.charCodeAt(endIdx - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff && endIdx < text.length) {
      endIdx++;
    }
    window = text.slice(0, endIdx);
  }
  const buf = Buffer.from(window, "utf8");
  if (buf.length <= maxBytes) return window;
  let cut = maxBytes;
  while (cut > 0 && ((buf[cut] ?? 0) & 0xc0) === 0x80) {
    cut--;
  }
  return buf.subarray(0, cut).toString("utf8");
}

function sliceTailByUtf8Bytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return "";
  let window = text;
  if (text.length > maxBytes + 4) {
    let startIdx = text.length - (maxBytes + 4);
    const firstCode = text.charCodeAt(startIdx);
    if (firstCode >= 0xdc00 && firstCode <= 0xdfff && startIdx + 1 < text.length) {
      startIdx++;
    }
    window = text.slice(startIdx);
  }
  const buf = Buffer.from(window, "utf8");
  if (buf.length <= maxBytes) return window;
  let start = buf.length - maxBytes;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString("utf8");
}

function sliceHeadWithLineCount(
  lines: readonly string[],
  maxLines: number,
  maxBytes: number,
  fullText?: string,
): { text: string; keptLines: number } {
  if (maxLines <= 0 || maxBytes <= 0 || lines.length === 0) {
    return { text: "", keptLines: 0 };
  }
  const allSelected = lines.length <= maxLines;
  const selected = allSelected ? lines : lines.slice(0, maxLines);
  const joined = allSelected && fullText !== undefined ? fullText : selected.join("\n");
  const text = sliceHeadByUtf8Bytes(joined, maxBytes);
  if (text.length === 0) return { text: "", keptLines: 0 };
  if (text.length === joined.length) {
    return { text, keptLines: selected.length };
  }
  const parts = text.split("\n");
  // If the byte cut landed right after a newline, the trailing empty segment
  // belongs to the next line only when that source line itself is empty.
  if (text.endsWith("\n") && selected[parts.length - 1] !== "") {
    return { text, keptLines: Math.max(0, parts.length - 1) };
  }
  return { text, keptLines: parts.length };
}

function sliceTailWithLineCount(
  lines: readonly string[],
  maxLines: number,
  maxBytes: number,
  fullText?: string,
): { text: string; keptLines: number } {
  if (maxLines <= 0 || maxBytes <= 0 || lines.length === 0) {
    return { text: "", keptLines: 0 };
  }
  const allSelected = lines.length <= maxLines;
  const selected = allSelected ? lines : lines.slice(lines.length - maxLines);
  const joined = allSelected && fullText !== undefined ? fullText : selected.join("\n");
  const text = sliceTailByUtf8Bytes(joined, maxBytes);
  if (text.length === 0) return { text: "", keptLines: 0 };
  if (text.length === joined.length) {
    return { text, keptLines: selected.length };
  }
  const parts = text.split("\n");
  // If the byte cut landed right before a newline, the leading empty segment
  // belongs to the earlier line only when that source line itself is empty.
  if (text.startsWith("\n") && selected[selected.length - parts.length] !== "") {
    return { text, keptLines: Math.max(0, parts.length - 1) };
  }
  return { text, keptLines: parts.length };
}

function normalizeArtifactId(
  stored: { artifactId?: string | null } | string | null | undefined,
): string | undefined {
  let raw: string | null | undefined;
  if (typeof stored === "string") {
    raw = stored;
  } else if (stored && typeof stored === "object") {
    raw = stored.artifactId;
  }
  return typeof raw === "string" &&
    raw.length <= MAX_ARTIFACT_ID_LENGTH &&
    ARTIFACT_ID_EXACT_RE.test(raw)
    ? raw
    : undefined;
}

function formatElisionMarker(
  omittedLines: number,
  omittedBytes: number,
  artifactId?: string,
): string {
  const unit = omittedLines === 1 ? "line" : "lines";
  const lineSummary = omittedLines > 0 ? `${omittedLines} ${unit} / ` : "";
  const elidedSummary = `elided ${lineSummary}${omittedBytes} bytes (partial lines at cut truncated)`;
  const validId = normalizeArtifactId(artifactId);
  if (validId) {
    return `... [${elidedSummary}; full output stored in artifact ${validId} — call retrieve_artifact("${validId}") to inspect] ...`;
  }
  return `... [${elidedSummary}; artifact store unavailable — use search_transcript to inspect full output] ...`;
}

function extractArtifactIdFromText(text: string): string | undefined {
  const cardMatch = CARD_WHOLE_TEXT_RE.exec(text);
  if (cardMatch?.[1]) return normalizeArtifactId(cardMatch[1]);
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const elidedMatch = ELIDED_MARKER_LINE_RE.exec(line);
    if (elidedMatch?.[1]) {
      const validId = normalizeArtifactId(elidedMatch[1]);
      if (validId) return validId;
    }
  }
  return undefined;
}

export function extractShapedArtifactId(text: string): string | undefined {
  return extractArtifactIdFromText(text);
}

export function isShapedStubFor(text: string, artifactId: string): boolean {
  const validId = normalizeArtifactId(artifactId);
  if (!validId) return false;
  return extractArtifactIdFromText(text) === validId;
}

interface ShapedCandidate {
  head: string;
  tail: string;
  text: string;
  omittedLines: number;
  omittedBytes: number;
}

function buildShapedCandidate(
  rawText: string,
  lines: readonly string[],
  totalBytes: number,
  exceedsLines: boolean,
  opts: ShapeToolOutputOptions,
  overheadBytes: number,
  artifactIdForMarker?: string,
): ShapedCandidate | null {
  const maxLinesCap = Math.max(0, opts.maxLines);
  if (maxLinesCap === 0) return null;
  const contentLineBudget = maxLinesCap - 1;
  const cfgHeadLines = Math.max(0, opts.headLines);
  const cfgTailLines = Math.max(0, opts.tailLines);
  const configuredLineSum = cfgHeadLines + cfgTailLines;
  let effHeadLines =
    configuredLineSum > contentLineBudget && configuredLineSum > 0
      ? Math.ceil((contentLineBudget * cfgHeadLines) / configuredLineSum)
      : cfgHeadLines;
  let effTailLines =
    configuredLineSum > contentLineBudget && configuredLineSum > 0
      ? contentLineBudget - effHeadLines
      : cfgTailLines;
  effHeadLines = Math.min(effHeadLines, cfgHeadLines);
  effTailLines = Math.min(effTailLines, cfgTailLines, Math.max(0, contentLineBudget - effHeadLines));

  const targetMaxBytes = Math.min(opts.maxBytes, totalBytes - 1);
  const byteBudget = targetMaxBytes - overheadBytes;
  if (byteBudget < 0) return null;

  const cfgHeadBytes = Math.max(0, opts.headBytes);
  const cfgTailBytes = Math.max(0, opts.tailBytes);
  const configuredByteSum = cfgHeadBytes + cfgTailBytes;
  let headByteBudget =
    configuredByteSum > 0 ? Math.floor((byteBudget * cfgHeadBytes) / configuredByteSum) : 0;
  let tailByteBudget = byteBudget - headByteBudget;
  headByteBudget = Math.min(headByteBudget, cfgHeadBytes);
  tailByteBudget = Math.min(tailByteBudget, cfgTailBytes);

  let headSlice: { text: string; keptLines: number };
  let tailSlice: { text: string; keptLines: number };
  if (exceedsLines) {
    headSlice = sliceHeadWithLineCount(lines, effHeadLines, headByteBudget);
    tailSlice = sliceTailWithLineCount(lines, effTailLines, tailByteBudget);
  } else {
    headSlice = sliceHeadWithLineCount(lines, lines.length, headByteBudget, rawText);
    tailSlice = sliceTailWithLineCount(lines, lines.length, tailByteBudget, rawText);
    const totalPhysicalLines =
      (headSlice.text ? headSlice.text.split("\n").length : 0) +
      (tailSlice.text ? tailSlice.text.split("\n").length : 0);
    if (
      headSlice.keptLines + tailSlice.keptLines > contentLineBudget ||
      totalPhysicalLines > contentLineBudget
    ) {
      headSlice = sliceHeadWithLineCount(lines, effHeadLines, headByteBudget);
      tailSlice = sliceTailWithLineCount(lines, effTailLines, tailByteBudget);
    }
  }

  const head = headSlice.text;
  const tail = tailSlice.text;
  const omittedLines = Math.max(0, lines.length - headSlice.keptLines - tailSlice.keptLines);
  const keptBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
  const omittedBytes = Math.max(0, totalBytes - keptBytes);
  if (omittedBytes === 0) return null;

  const marker = formatElisionMarker(omittedLines, omittedBytes, artifactIdForMarker);
  const text = [head, marker, tail].filter((part) => part.length > 0).join("\n");
  return { head, tail, text, omittedLines, omittedBytes };
}

function convergeShapedCandidate(
  rawText: string,
  lines: readonly string[],
  totalBytes: number,
  exceedsLines: boolean,
  opts: ShapeToolOutputOptions,
  artifactIdForMarker?: string,
): ShapedCandidate | null {
  const maxLinesCap = Math.max(0, opts.maxLines);
  if (maxLinesCap === 0) return null;
  const targetMaxBytes = Math.min(opts.maxBytes, totalBytes - 1);
  let lineCap = maxLinesCap;
  let overheadGuess =
    Buffer.byteLength(formatElisionMarker(lines.length, totalBytes, artifactIdForMarker), "utf8") + 2;

  for (let attempt = 0; attempt < 8; attempt++) {
    const effOpts = lineCap === opts.maxLines ? opts : { ...opts, maxLines: lineCap };
    const cand = buildShapedCandidate(
      rawText,
      lines,
      totalBytes,
      exceedsLines,
      effOpts,
      overheadGuess,
      artifactIdForMarker,
    );
    if (!cand) break;
    const candBytes = Buffer.byteLength(cand.text, "utf8");
    const candLines = cand.text.split("\n").length;
    if (
      candBytes <= targetMaxBytes &&
      candLines <= maxLinesCap &&
      cand.text.length < rawText.length
    ) {
      return cand;
    }

    const actualOverhead =
      candBytes - (Buffer.byteLength(cand.head, "utf8") + Buffer.byteLength(cand.tail, "utf8"));
    const remainingBudget = Math.max(0, targetMaxBytes - overheadGuess);
    if (candBytes > targetMaxBytes) {
      const overBy = candBytes - targetMaxBytes;
      overheadGuess = Math.max(
        actualOverhead,
        overheadGuess + Math.max(overBy, Math.ceil(remainingBudget / 2)),
      );
    }
    if (candLines > maxLinesCap) {
      lineCap = Math.max(1, Math.min(lineCap - 1, Math.floor(lineCap / 2)));
    }
    if (cand.text.length >= rawText.length) {
      overheadGuess += Math.max(1, Math.ceil(remainingBudget / 2));
    }
  }

  // Fallback: try marker plus a tiny head/tail, then pure marker-only.
  const bareMarker = formatElisionMarker(lines.length, totalBytes, artifactIdForMarker);
  const bareMarkerBytes = Buffer.byteLength(bareMarker, "utf8");
  if (bareMarkerBytes <= targetMaxBytes && maxLinesCap >= 3) {
    const smallBudget = Math.min(64, targetMaxBytes - bareMarkerBytes - 2);
    if (smallBudget > 0) {
      const smallCand = buildShapedCandidate(
        rawText,
        lines,
        totalBytes,
        true,
        { ...opts, maxLines: 3, headLines: 1, tailLines: 1 },
        targetMaxBytes - smallBudget,
        artifactIdForMarker,
      );
      if (
        smallCand &&
        Buffer.byteLength(smallCand.text, "utf8") <= targetMaxBytes &&
        smallCand.text.split("\n").length <= maxLinesCap &&
        smallCand.text.length < rawText.length
      ) {
        return smallCand;
      }
    }
  }
  if (bareMarkerBytes <= targetMaxBytes && bareMarker.length < rawText.length) {
    return {
      head: "",
      tail: "",
      text: bareMarker,
      omittedLines: lines.length,
      omittedBytes: totalBytes,
    };
  }
  return null;
}

/**
 * Shapes oversized tool outputs at ingestion while preserving exact bytes for
 * exempt tools and commands.
 *
 * `shell` and `web_fetch` are shapeable by design (bulk free-form output); when
 * truncated, the inserted elision marker instructs the model to call
 * `retrieve_artifact` for the full original text. For `shell`, shaping can cut
 * IDs or paths emitted by commands that are not recognised as file reads, while
 * dedicated structured tools (`git_log`, `git_diff`, `find_files`, `search_code`)
 * remain exact-bytes. Shell commands with missing/unknown command strings,
 * detected or known file reads, read-only git content commands, or `isError`
 * results are left unshaped.
 */
export function shapeToolOutput(input: ShapeToolOutputInput): ShapeToolOutputResult {
  const opts = resolveShapeOptions(input.options);
  const rawText = input.text;
  const rawTokens = estimateTokens(rawText);

  const unchanged = (): ShapeToolOutputResult => ({
    text: rawText,
    shaped: false,
    artifactId: extractArtifactIdFromText(rawText),
    rawTokens,
    shapedTokens: rawTokens,
    omittedLines: 0,
    omittedBytes: 0,
  });

  if (!rawText) return unchanged();
  if (
    input.preserveExactBytes ||
    input.isError ||
    isExactBytesTool(input.toolName, opts.exactBytesTools) ||
    (input.toolName === "shell" && !isShapeableShellCommand(input.command))
  ) {
    return unchanged();
  }

  const totalBytes = Buffer.byteLength(rawText, "utf8");
  const lines = rawText.split("\n");
  const exceedsLines = lines.length > opts.maxLines;
  const exceedsBytes = totalBytes > opts.maxBytes;

  if (rawTokens <= opts.inlineThresholdTokens || (!exceedsLines && !exceedsBytes)) {
    return unchanged();
  }

  const maxLinesCap = Math.max(0, opts.maxLines);
  const targetMaxBytes = Math.min(opts.maxBytes, totalBytes - 1);

  // Build the candidate once with the worst-case reserved marker width
  // (MAX_ARTIFACT_ID_LENGTH) before calling storeArtifact, then substitute the
  // resolved artifact ID (or unavailable fallback) without rebuilding.
  const explicitArtifactId = normalizeArtifactId(input.artifactId);
  const probeId = explicitArtifactId || input.storeArtifact ? RESERVED_ARTIFACT_ID : undefined;
  const candidate = convergeShapedCandidate(rawText, lines, totalBytes, exceedsLines, opts, probeId);
  if (
    !candidate ||
    candidate.text.length >= rawText.length ||
    Buffer.byteLength(candidate.text, "utf8") > targetMaxBytes ||
    candidate.text.split("\n").length > maxLinesCap
  ) {
    return unchanged();
  }

  let resolvedArtifactId = explicitArtifactId;
  if (!resolvedArtifactId && input.storeArtifact) {
    try {
      resolvedArtifactId = normalizeArtifactId(input.storeArtifact(rawText));
    } catch {
      resolvedArtifactId = undefined;
    }
  }

  const finalMarker = formatElisionMarker(
    candidate.omittedLines,
    candidate.omittedBytes,
    resolvedArtifactId,
  );
  const finalText =
    resolvedArtifactId === probeId
      ? candidate.text
      : [candidate.head, finalMarker, candidate.tail].filter((part) => part.length > 0).join("\n");

  if (
    finalText.length >= rawText.length ||
    Buffer.byteLength(finalText, "utf8") > targetMaxBytes ||
    finalText.split("\n").length > maxLinesCap
  ) {
    return unchanged();
  }

  const out: ShapeToolOutputResult = {
    text: finalText,
    shaped: true,
    rawTokens,
    shapedTokens: estimateTokens(finalText),
    omittedLines: candidate.omittedLines,
    omittedBytes: candidate.omittedBytes,
  };
  if (resolvedArtifactId) out.artifactId = resolvedArtifactId;
  return out;
}

export function buildToolResultStub(candidate: StubCandidate): string {
  const artifactId = extractArtifactIdFromText(candidate.text);
  const artifactClause = artifactId ? `, artifact ${artifactId}` : "";
  const transcriptHint = `search_transcript({ id: "${candidate.eventId}" })`;
  const retrieveClause = artifactId
    ? `use ${transcriptHint} or retrieve_artifact("${artifactId}") to inspect`
    : `use ${transcriptHint} to inspect`;
  return `[tool_result ${candidate.eventId} (${candidate.toolName}, ~${candidate.estimatedTokens} tokens${artifactClause}) stubbed — ${retrieveClause}]`;
}

/**
 * Compatible with `compaction.ts`'s `StubPlanner` signature.
 * Replaces eligible candidates (`estimatedTokens >= minTokens`) with a
 * single-line stub carrying the canonical event ID and any artifact ID found in
 * the shaped text.
 *
 * By design, stubbing applies during compaction to stale completed-turn results
 * and older in-flight results regardless of tool name: exact-bytes protection
 * is an ingestion-time rule (`shapeToolOutput`), not a stubbing rule. The model
 * can recover stubbed results from the canonical log with `search_transcript`
 * (and raw unshaped output with `retrieve_artifact` when an artifact ID is
 * present).
 */
export function planToolResultStubs(
  candidates: readonly StubCandidate[],
  options: { phase: "stale" | "in_flight"; minTokens: number; keepRecent: number },
): StubEntry[] {
  const minTokens = options.minTokens;
  const entries: StubEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.estimatedTokens < minTokens) continue;
    const stubText = buildToolResultStub(candidate);
    if (
      stubText.length >= candidate.text.length ||
      Buffer.byteLength(stubText, "utf8") >= Buffer.byteLength(candidate.text, "utf8") ||
      estimateTokens(stubText) >= candidate.estimatedTokens
    ) {
      continue;
    }
    entries.push({ eventId: candidate.eventId, stubText });
  }
  return entries;
}
