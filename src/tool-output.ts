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
const ARTIFACT_ID_EXACT_RE = new RegExp(`^${ARTIFACT_ID_GRAMMAR}$`);
const ELIDED_ARTIFACT_ID_RE = new RegExp(
  `full output stored in artifact (${ARTIFACT_ID_GRAMMAR})(?=\\s|—|$)`,
);
const CARD_ARTIFACT_ID_RE = new RegExp(
  `\\[artifact:\\s*(${ARTIFACT_ID_GRAMMAR})(?=[\\s|\\],;]|$)`,
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

function sliceHeadLinesFromArray(lines: readonly string[], maxLines: number): string {
  if (maxLines <= 0 || lines.length === 0) return "";
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(0, maxLines).join("\n");
}

function sliceTailLinesFromArray(lines: readonly string[], maxLines: number): string {
  if (maxLines <= 0 || lines.length === 0) return "";
  if (lines.length <= maxLines) return lines.join("\n");
  return lines.slice(lines.length - maxLines).join("\n");
}

function countTouchedLines(fragment: string, trimLeading: boolean, trimTrailing: boolean): number {
  if (!fragment) return 0;
  let count = fragment.split("\n").length;
  if (trimLeading && fragment.startsWith("\n")) count--;
  if (trimTrailing && fragment.endsWith("\n")) count--;
  return Math.max(0, count);
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
  return typeof raw === "string" && ARTIFACT_ID_EXACT_RE.test(raw) ? raw : undefined;
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
  const elidedMatch = ELIDED_ARTIFACT_ID_RE.exec(text);
  if (elidedMatch?.[1]) return elidedMatch[1];
  const cardMatch = CARD_ARTIFACT_ID_RE.exec(text);
  if (cardMatch?.[1]) return cardMatch[1];
  return undefined;
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

  let head: string;
  let tail: string;
  if (exceedsLines) {
    head = sliceHeadByUtf8Bytes(sliceHeadLinesFromArray(lines, effHeadLines), headByteBudget);
    tail = sliceTailByUtf8Bytes(sliceTailLinesFromArray(lines, effTailLines), tailByteBudget);
  } else {
    head = sliceHeadByUtf8Bytes(rawText, headByteBudget);
    tail = sliceTailByUtf8Bytes(rawText, tailByteBudget);
    const keptHead = head ? head.split("\n").length : 0;
    const keptTail = tail ? tail.split("\n").length : 0;
    if (keptHead + keptTail > contentLineBudget) {
      head = sliceHeadByUtf8Bytes(sliceHeadLinesFromArray(lines, effHeadLines), headByteBudget);
      tail = sliceTailByUtf8Bytes(sliceTailLinesFromArray(lines, effTailLines), tailByteBudget);
    }
  }

  const keptHeadLines = countTouchedLines(head, false, true);
  const keptTailLines = countTouchedLines(tail, true, false);
  const omittedLines = Math.max(0, lines.length - keptHeadLines - keptTailLines);
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
  const targetMaxBytes = Math.min(opts.maxBytes, totalBytes - 1);
  let overheadGuess =
    Buffer.byteLength(formatElisionMarker(lines.length, totalBytes, artifactIdForMarker), "utf8") + 2;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cand = buildShapedCandidate(
      rawText,
      lines,
      totalBytes,
      exceedsLines,
      opts,
      overheadGuess,
      artifactIdForMarker,
    );
    if (!cand) return null;
    const candBytes = Buffer.byteLength(cand.text, "utf8");
    const candLines = cand.text.split("\n").length;
    if (candBytes <= targetMaxBytes && candLines <= maxLinesCap) {
      return cand;
    }
    const actualOverhead =
      candBytes - (Buffer.byteLength(cand.head, "utf8") + Buffer.byteLength(cand.tail, "utf8"));
    if (actualOverhead <= overheadGuess) return null;
    overheadGuess = actualOverhead;
  }
  return null;
}

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
    (input.toolName === "shell" && input.command !== undefined && detectShellReads(input.command) !== null)
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

  // Probe with a worst-case marker before calling storeArtifact so we never
  // persist an artifact when the shaped result would exceed caps or not shrink.
  const explicitArtifactId = normalizeArtifactId(input.artifactId);
  const probeId = explicitArtifactId ?? (input.storeArtifact ? "art_000000000000" : undefined);
  const probe = convergeShapedCandidate(rawText, lines, totalBytes, exceedsLines, opts, probeId);
  if (!probe || probe.text.length >= rawText.length || Buffer.byteLength(probe.text, "utf8") > targetMaxBytes) {
    return unchanged();
  }

  let resolvedArtifactId = explicitArtifactId;
  if (!resolvedArtifactId && input.storeArtifact) {
    resolvedArtifactId = normalizeArtifactId(input.storeArtifact(rawText));
  }

  const finalCand =
    resolvedArtifactId === probeId
      ? probe
      : convergeShapedCandidate(rawText, lines, totalBytes, exceedsLines, opts, resolvedArtifactId);
  if (
    !finalCand ||
    finalCand.text.length >= rawText.length ||
    Buffer.byteLength(finalCand.text, "utf8") > targetMaxBytes ||
    finalCand.text.split("\n").length > maxLinesCap
  ) {
    return unchanged();
  }

  const out: ShapeToolOutputResult = {
    text: finalCand.text,
    shaped: true,
    rawTokens,
    shapedTokens: estimateTokens(finalCand.text),
    omittedLines: finalCand.omittedLines,
    omittedBytes: finalCand.omittedBytes,
  };
  if (resolvedArtifactId) out.artifactId = resolvedArtifactId;
  return out;
}

export function buildToolResultStub(candidate: StubCandidate): string {
  const artifactId = extractArtifactIdFromText(candidate.text);
  const artifactClause = artifactId ? `, artifact ${artifactId}` : "";
  const retrieveClause = artifactId
    ? `use search_transcript("${candidate.eventId}") or retrieve_artifact("${artifactId}") to inspect`
    : `use search_transcript("${candidate.eventId}") to inspect`;
  return `[tool_result ${candidate.eventId} (${candidate.toolName}, ~${candidate.estimatedTokens} tokens${artifactClause}) stubbed — ${retrieveClause}]`;
}

/**
 * Compatible with `compaction.ts`'s `StubPlanner` signature.
 * Replaces eligible candidates (>= minTokens) with a single-line stub carrying
 * the canonical event ID and any artifact ID found in the shaped text.
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
