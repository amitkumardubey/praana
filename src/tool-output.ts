/**
 * Deterministic tool-output ingestion shaper and stale-result batch stubber.
 *
 * 1. Ingestion shaping (`shapeToolOutput`): runs once when a tool result enters
 *    the log. Results over `inlineThresholdTokens` keep bounded head and tail
 *    lines/bytes with an elision marker naming the side-file artifact ID
 *    (`retrieve_artifact`). Inputs whose exact bytes the model must reproduce
 *    (`read_file`, LSP location tools, `retrieve_artifact`) are never shaped.
 * 2. Stale-result batch stubbing (`planToolResultStubs`, `planTurnBatchStubs`):
 *    runs as a batch at a compaction trigger (never per step), replacing large
 *    tool results older than the most recent K results with a single-line stub
 *    carrying the canonical event ID (and artifact ID when present) while
 *    preserving call/result pairing.
 */

import {
  readFullSessionCanonicalRecords,
  type CanonicalRecord,
} from "./canonical-transcript.js";
import { eventsAfterResetBoundary } from "./event-log.js";
import { estimateTokens } from "./token-estimate.js";
import type { Event } from "./types.js";

export const DEFAULT_INLINE_THRESHOLD_TOKENS = 400;
export const DEFAULT_SHAPE_MAX_LINES = 80;
export const DEFAULT_SHAPE_HEAD_LINES = 40;
export const DEFAULT_SHAPE_TAIL_LINES = 40;
export const DEFAULT_SHAPE_MAX_BYTES = 8192;
export const DEFAULT_SHAPE_HEAD_BYTES = 4096;
export const DEFAULT_SHAPE_TAIL_BYTES = 4096;
export const DEFAULT_STUB_KEEP_RECENT = 3;
export const DEFAULT_STUB_MIN_TOKENS = 256;

/**
 * Tools whose output the model must reproduce verbatim (`edit_file` targets,
 * LSP diagnostic/symbol locations, or explicit artifact retrievals).
 */
export const DEFAULT_EXACT_BYTES_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "lsp_diagnostics",
  "lsp_definition",
  "lsp_references",
  "lsp_hover",
  "lsp_symbols",
  "retrieve_artifact",
]);

const ELISION_MARKER_PATTERN =
  /^... \[elided \d+ lines \/ \d+ bytes; (?:full output stored in artifact [^\s—]+ — call retrieve_artifact\("[^"]+"\) to inspect|artifact store unavailable — use search_transcript to inspect full output)\] ...$/m;

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
  if (DEFAULT_EXACT_BYTES_TOOLS.has(toolName)) return true;
  if (!custom) return false;
  return "has" in custom ? custom.has(toolName) : custom.includes(toolName);
}

function sliceHeadByUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = chars.slice(0, mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return chars.slice(0, low).join("");
}

function sliceTailByUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const chars = Array.from(text);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = chars.slice(mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return chars.slice(low).join("");
}

function formatElisionMarker(
  omittedLines: number,
  omittedBytes: number,
  artifactId?: string,
): string {
  if (artifactId) {
    return `... [elided ${omittedLines} lines / ${omittedBytes} bytes; full output stored in artifact ${artifactId} — call retrieve_artifact("${artifactId}") to inspect] ...`;
  }
  return `... [elided ${omittedLines} lines / ${omittedBytes} bytes; artifact store unavailable — use search_transcript to inspect full output] ...`;
}

function extractArtifactIdFromText(text: string): string | undefined {
  const elidedMatch = /full output stored in artifact (art_[A-Za-z0-9_-]+)/.exec(text);
  if (elidedMatch?.[1]) return elidedMatch[1];
  const cardMatch = /\[artifact:\s*(art_[A-Za-z0-9_-]+)/.exec(text);
  if (cardMatch?.[1]) return cardMatch[1];
  return undefined;
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
  if (input.preserveExactBytes || isExactBytesTool(input.toolName, opts.exactBytesTools)) {
    return unchanged();
  }
  // Idempotence: already-shaped strings are never shaped a second time.
  if (ELISION_MARKER_PATTERN.test(rawText)) {
    return unchanged();
  }

  const totalBytes = Buffer.byteLength(rawText, "utf8");
  const lines = rawText.split("\n");
  const exceedsLines = lines.length > opts.maxLines;
  const exceedsBytes = totalBytes > opts.maxBytes;

  if (rawTokens <= opts.inlineThresholdTokens || (!exceedsLines && !exceedsBytes)) {
    return unchanged();
  }

  let head: string;
  let tail: string;
  let omittedLines: number;

  if (exceedsLines && lines.length > opts.headLines + opts.tailLines) {
    const headSlice = lines.slice(0, opts.headLines).join("\n");
    const tailSlice = opts.tailLines > 0 ? lines.slice(lines.length - opts.tailLines).join("\n") : "";
    head = sliceHeadByUtf8Bytes(headSlice, opts.headBytes);
    tail = sliceTailByUtf8Bytes(tailSlice, opts.tailBytes);
    const keptHeadLines = head ? head.split("\n").length : 0;
    const keptTailLines = tail ? tail.split("\n").length : 0;
    omittedLines = Math.max(1, lines.length - keptHeadLines - keptTailLines);
  } else {
    head = sliceHeadByUtf8Bytes(rawText, opts.headBytes);
    tail = sliceTailByUtf8Bytes(rawText, opts.tailBytes);
    const keptLines = (head ? head.split("\n").length : 0) + (tail ? tail.split("\n").length : 0);
    omittedLines = Math.max(0, lines.length - keptLines);
  }

  const keptBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
  const omittedBytes = Math.max(0, totalBytes - keptBytes);
  if (omittedBytes === 0) {
    return unchanged();
  }

  // Probe with a worst-case marker before calling storeArtifact so we never
  // persist an artifact when the shaped result would not be strictly shorter.
  const probeMarker = formatElisionMarker(omittedLines, omittedBytes, input.artifactId ?? "art_000000000000");
  const probeText = `${head}\n${probeMarker}\n${tail}`;
  if (probeText.length >= rawText.length || Buffer.byteLength(probeText, "utf8") >= totalBytes) {
    return unchanged();
  }

  let resolvedArtifactId = input.artifactId;
  if (!resolvedArtifactId && input.storeArtifact) {
    const stored = input.storeArtifact(rawText);
    if (typeof stored === "string" && stored.length > 0) {
      resolvedArtifactId = stored;
    } else if (stored && typeof stored === "object" && typeof stored.artifactId === "string" && stored.artifactId.length > 0) {
      resolvedArtifactId = stored.artifactId;
    }
  }

  const marker = formatElisionMarker(omittedLines, omittedBytes, resolvedArtifactId);
  const shapedText = `${head}\n${marker}\n${tail}`;
  if (shapedText.length >= rawText.length || Buffer.byteLength(shapedText, "utf8") >= totalBytes) {
    return unchanged();
  }

  return {
    text: shapedText,
    shaped: true,
    ...(resolvedArtifactId ? { artifactId: resolvedArtifactId } : {}),
    rawTokens,
    shapedTokens: estimateTokens(shapedText),
    omittedLines,
    omittedBytes,
  };
}

export interface StubCandidate {
  eventId: string;
  turnId: number;
  callId: string;
  toolName: string;
  text: string;
  isError: boolean;
  estimatedTokens: number;
}

export interface StubEntry {
  eventId: string;
  stubText: string;
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
  options: { phase?: "stale" | "in_flight"; minTokens?: number; keepRecent?: number } = {},
): StubEntry[] {
  const minTokens = options.minTokens ?? DEFAULT_STUB_MIN_TOKENS;
  const entries: StubEntry[] = [];
  for (const candidate of candidates) {
    if (candidate.estimatedTokens < minTokens) continue;
    const stubText = buildToolResultStub(candidate);
    if (estimateTokens(stubText) >= candidate.estimatedTokens) continue;
    entries.push({ eventId: candidate.eventId, stubText });
  }
  return entries;
}

export interface BatchStubOptions {
  /** Batch stubbing fires only at a compaction watermark trigger, never per step. */
  triggered: boolean;
  keepRecent?: number;
  minTokens?: number;
}

/**
 * Batch planner over canonical events in the current reset epoch.
 * Returns `[]` unless `triggered` is true (preserving append-only history between
 * rewrites). When triggered, keeps the most recent `keepRecent` (default 3)
 * tool results verbatim and stubs older tool results of at least `minTokens`.
 */
export function planTurnBatchStubs(
  events: readonly Event[],
  options: BatchStubOptions,
): StubEntry[] {
  if (!options.triggered) return [];
  const keepRecent = Math.max(1, options.keepRecent ?? DEFAULT_STUB_KEEP_RECENT);
  const minTokens = options.minTokens ?? DEFAULT_STUB_MIN_TOKENS;

  const epochEvents = eventsAfterResetBoundary([...events]).filter(
    (ev) => ev.kind === "canonical_message",
  );
  const epochRecords = readFullSessionCanonicalRecords(epochEvents);
  const allResults: StubCandidate[] = [];
  for (let i = 0; i < epochRecords.length; i++) {
    const rec = epochRecords[i];
    const ev = epochEvents[i];
    if (!rec || !ev || rec.kind !== "tool_result") continue;
    allResults.push({
      eventId: ev.event_id,
      turnId: rec.turnId,
      callId: rec.message.callId,
      toolName: rec.message.toolName,
      text: rec.message.text,
      isError: rec.message.isError,
      estimatedTokens: estimateTokens(rec.message.text),
    });
  }

  if (allResults.length <= keepRecent) return [];
  const staleSlice = allResults.slice(0, allResults.length - keepRecent);
  return planToolResultStubs(staleSlice, { phase: "stale", minTokens, keepRecent });
}

/**
 * Pure helper that applies a committed `stubSet` to canonical events in the
 * current reset epoch without mutating the underlying events or breaking
 * `tool_call` / `tool_result` pairing.
 */
export function applyStubsToCanonicalRecords(
  events: readonly Event[],
  stubSet: readonly StubEntry[],
): CanonicalRecord[] {
  const stubMap = new Map(stubSet.map((s) => [s.eventId, s.stubText]));
  const epochEvents = eventsAfterResetBoundary([...events]).filter(
    (ev) => ev.kind === "canonical_message",
  );
  const epochRecords = readFullSessionCanonicalRecords(epochEvents);
  const records: CanonicalRecord[] = [];
  for (let i = 0; i < epochRecords.length; i++) {
    const rec = epochRecords[i];
    const ev = epochEvents[i];
    if (!rec || !ev) continue;
    if (rec.kind === "tool_result" && stubMap.has(ev.event_id)) {
      const replacement = stubMap.get(ev.event_id);
      if (replacement !== undefined) {
        records.push({
          ...rec,
          message: { ...rec.message, text: replacement },
        });
        continue;
      }
    }
    records.push(rec);
  }
  return records;
}
