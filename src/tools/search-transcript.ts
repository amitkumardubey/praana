/**
 * `search_transcript` — searches canonical message records in the session event
 * log using BM25 + case-insensitive substring matching (no regex), and fetches
 * full/ranged message content and surrounding messages by event ID.
 *
 * Includes absorbed and stubbed messages regardless of compaction generation.
 * Defaults to the current reset epoch; `include_previous_resets: true` also
 * searches earlier `/clear` reset epochs in the same session.
 */

import { z } from "zod";
import {
  readFullSessionCanonicalRecords,
  type CanonicalRecord,
} from "../canonical-transcript.js";
import { isResetBoundaryEvent, type EventLog } from "../event-log.js";
import {
  bm25Score,
  buildBM25StatsFromTokens,
  tokenize,
} from "../utils/bm25.js";
import { defineTool } from "./tool-def.js";

export const DEFAULT_SNIPPET_CHARS = 300;
export const DEFAULT_FETCH_MAX_CHARS = 8000;
const SESSION_START_EPOCH = "session_start";

export interface IndexedTranscriptEntry {
  id: string;
  resetEpoch: string;
  turnId: number;
  kind: CanonicalRecord["kind"];
  toolName?: string;
  callId?: string;
  isError?: boolean;
  artifactId?: string;
  text: string;
  searchText: string;
  timestamp: number;
  epochPosition: number;
  logPosition: number;
}

function extractArtifactId(text: string): string | undefined {
  const elidedMatch = /full output stored in artifact (art_[A-Za-z0-9_-]+)/.exec(text);
  if (elidedMatch?.[1]) return elidedMatch[1];
  const cardMatch = /\[artifact:\s*(art_[A-Za-z0-9_-]+)/.exec(text);
  if (cardMatch?.[1]) return cardMatch[1];
  return undefined;
}

function extractRecordTexts(record: CanonicalRecord): {
  text: string;
  searchText: string;
  toolName?: string;
  callId?: string;
  isError?: boolean;
  artifactId?: string;
} {
  switch (record.kind) {
    case "user_input":
    case "wrap_up": {
      const text = record.message.text;
      return { text, searchText: text, artifactId: extractArtifactId(text) };
    }
    case "assistant": {
      const parts: string[] = [];
      if (record.message.text) parts.push(record.message.text);
      if (record.message.thinking) parts.push(record.message.thinking);
      const searchParts = [...parts];
      for (const tc of record.message.toolCalls ?? []) {
        const callText = `${tc.name}(${JSON.stringify(tc.args)})`;
        parts.push(callText);
        if (tc.name !== "search_transcript") searchParts.push(callText);
      }
      const text = parts.join("\n");
      return { text, searchText: searchParts.join("\n"), artifactId: extractArtifactId(text) };
    }
    case "tool_result": {
      const text = record.message.text;
      const searchText = `${record.message.toolName} ${record.message.callId}\n${text}`;
      return {
        text,
        searchText,
        toolName: record.message.toolName,
        callId: record.message.callId,
        isError: record.message.isError,
        artifactId: extractArtifactId(text),
      };
    }
    case "notice":
    case "snapshot":
    case "summary": {
      const text = JSON.stringify(record.message);
      return { text, searchText: text, artifactId: extractArtifactId(text) };
    }
    default: {
      const exhaustive: never = record;
      const text = JSON.stringify(exhaustive);
      return { text, searchText: text };
    }
  }
}

export function indexSessionTranscript(
  eventLog: Pick<EventLog, "readAll">,
): { entries: IndexedTranscriptEntry[]; currentResetEpoch: string } {
  const events = eventLog.readAll({ includeCanonical: true });
  let currentResetEpoch = SESSION_START_EPOCH;
  const entries: IndexedTranscriptEntry[] = [];
  let epochPosition = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    if (isResetBoundaryEvent(ev)) {
      currentResetEpoch = ev.event_id;
      epochPosition = 0;
      continue;
    }
    if (ev.kind !== "canonical_message") continue;
    let parsedRecords: CanonicalRecord[];
    try {
      parsedRecords = readFullSessionCanonicalRecords([ev]);
    } catch {
      continue;
    }
    const record = parsedRecords[0];
    if (!record) continue;
    const extracted = extractRecordTexts(record);
    const entry: IndexedTranscriptEntry = {
      id: ev.event_id,
      resetEpoch: currentResetEpoch,
      turnId: record.turnId,
      kind: record.kind,
      text: extracted.text,
      searchText: extracted.searchText,
      timestamp: ev.timestamp,
      epochPosition,
      logPosition: i,
    };
    if (extracted.toolName !== undefined) entry.toolName = extracted.toolName;
    if (extracted.callId !== undefined) entry.callId = extracted.callId;
    if (extracted.isError !== undefined) entry.isError = extracted.isError;
    if (extracted.artifactId !== undefined) entry.artifactId = extracted.artifactId;
    entries.push(entry);
    epochPosition++;
  }

  return { entries, currentResetEpoch };
}

function buildSnippet(
  text: string,
  query: string,
  maxChars: number = DEFAULT_SNIPPET_CHARS,
): { snippet: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { snippet: text, truncated: false };
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.trim().toLowerCase();
  let matchIndex = lowerQuery ? lowerText.indexOf(lowerQuery) : -1;

  if (matchIndex < 0) {
    const terms = lowerQuery.split(/\s+/).filter((t) => t.length > 0);
    for (const term of terms) {
      const idx = lowerText.indexOf(term);
      if (idx >= 0) {
        matchIndex = idx;
        break;
      }
    }
  }

  if (matchIndex < 0) {
    for (const tok of tokenize(query)) {
      const idx = lowerText.indexOf(tok);
      if (idx >= 0) {
        matchIndex = idx;
        break;
      }
    }
  }

  if (matchIndex < 0) matchIndex = 0;

  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, Math.min(matchIndex - half, text.length - maxChars));
  const end = Math.min(text.length, start + maxChars);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return {
    snippet: `${prefix}${text.slice(start, end)}${suffix}`,
    truncated: true,
  };
}

export interface TranscriptSearchMatch {
  id: string;
  resetEpoch: string;
  turnId: number;
  kind: CanonicalRecord["kind"];
  toolName?: string;
  callId?: string;
  isError?: boolean;
  artifactId?: string;
  score: number;
  snippet: string;
  truncated: boolean;
  totalChars: number;
  fetchHint: string;
}

export interface TranscriptNeighborSummary {
  id: string;
  turnId: number;
  kind: CanonicalRecord["kind"];
  toolName?: string;
  preview: string;
}

export interface TranscriptFetchedMessage {
  id: string;
  resetEpoch: string;
  turnId: number;
  kind: CanonicalRecord["kind"];
  toolName?: string;
  callId?: string;
  isError?: boolean;
  artifactId?: string;
  content: string;
  truncated: boolean;
  totalChars: number;
  totalLines: number;
  before?: TranscriptNeighborSummary[];
  after?: TranscriptNeighborSummary[];
}

export const searchTranscriptParameters = z.object({
  query: z
    .string()
    .optional()
    .describe("Search query (BM25 + case-insensitive substring; no regex). Provide query to search or id to fetch."),
  id: z
    .string()
    .optional()
    .describe("Canonical message event ID to fetch full/ranged content and optional surrounding context."),
  include_previous_resets: z
    .boolean()
    .optional()
    .default(false)
    .describe("When true, also search or fetch across earlier /clear reset epochs in this session."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of matches to return (1..50, default 10)."),
  context_messages: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe("When fetching by id, number of surrounding messages before and after in the same reset epoch (0..5)."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("When fetching by id, 1-based starting line number of the message content."),
  max_chars: z
    .number()
    .int()
    .min(100)
    .max(32000)
    .optional()
    .describe("When fetching by id, maximum characters of content to return (default 8000)."),
});

export type SearchTranscriptArgs = z.input<typeof searchTranscriptParameters>;

export type SearchTranscriptResult =
  | {
      ok: true;
      mode: "search";
      query: string;
      resetEpoch: string;
      includePreviousResets: boolean;
      matchCount: number;
      matches: TranscriptSearchMatch[];
    }
  | {
      ok: true;
      mode: "fetch";
      message: TranscriptFetchedMessage;
    }
  | {
      ok: false;
      error: string;
    };

function neighborSummary(entry: IndexedTranscriptEntry): TranscriptNeighborSummary {
  const out: TranscriptNeighborSummary = {
    id: entry.id,
    turnId: entry.turnId,
    kind: entry.kind,
    preview: entry.text.length > 200 ? `${entry.text.slice(0, 200)}…` : entry.text,
  };
  if (entry.toolName !== undefined) out.toolName = entry.toolName;
  return out;
}

export function createSearchTranscriptTool(ctx: {
  eventLog: Pick<EventLog, "readAll">;
}) {
  return {
    search_transcript: defineTool({
      description:
        "Search canonical message records in this session's transcript (BM25 + case-insensitive substring; no regex) " +
        "or fetch a message's full content and surrounding context by ID. Includes messages folded by compaction or " +
        "replaced by stubs. Searches the current reset epoch by default; set include_previous_resets=true to search across /clear.",
      parameters: searchTranscriptParameters,
      execute: async (rawArgs: SearchTranscriptArgs): Promise<SearchTranscriptResult> => {
        const parsed = searchTranscriptParameters.safeParse(rawArgs ?? {});
        if (!parsed.success) {
          return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
        }
        const args = parsed.data;
        const includePreviousResets = args.include_previous_resets ?? false;
        const { entries, currentResetEpoch } = indexSessionTranscript(ctx.eventLog);

        const scopedEntries = includePreviousResets
          ? entries
          : entries.filter((e) => e.resetEpoch === currentResetEpoch);

        // Mode A: Fetch by message ID
        if (args.id !== undefined) {
          const targetId = args.id.trim();
          if (!targetId) {
            return { ok: false, error: "Message id cannot be empty." };
          }
          const found = scopedEntries.find((e) => e.id === targetId);
          if (!found) {
            const inEarlierEpoch =
              !includePreviousResets && entries.some((e) => e.id === targetId);
            if (inEarlierEpoch) {
              return {
                ok: false,
                error: `Message "${targetId}" belongs to an earlier reset epoch; pass include_previous_resets: true to fetch it.`,
              };
            }
            return { ok: false, error: `Message "${targetId}" not found in transcript.` };
          }

          const lines = found.text.split("\n");
          const totalLines = lines.length;
          const totalChars = found.text.length;
          const startLine = Math.max(1, args.offset ?? 1);
          const slicedByLines =
            startLine > 1 ? lines.slice(startLine - 1).join("\n") : found.text;
          const maxChars = args.max_chars ?? DEFAULT_FETCH_MAX_CHARS;
          const truncated = slicedByLines.length > maxChars || startLine > 1;
          const content =
            slicedByLines.length > maxChars
              ? slicedByLines.slice(0, maxChars)
              : slicedByLines;

          const message: TranscriptFetchedMessage = {
            id: found.id,
            resetEpoch: found.resetEpoch,
            turnId: found.turnId,
            kind: found.kind,
            content,
            truncated,
            totalChars,
            totalLines,
          };
          if (found.toolName !== undefined) message.toolName = found.toolName;
          if (found.callId !== undefined) message.callId = found.callId;
          if (found.isError !== undefined) message.isError = found.isError;
          if (found.artifactId !== undefined) message.artifactId = found.artifactId;

          const contextCount = args.context_messages ?? 0;
          if (contextCount > 0) {
            const sameEpoch = entries.filter((e) => e.resetEpoch === found.resetEpoch);
            const idx = sameEpoch.findIndex((e) => e.id === found.id);
            if (idx >= 0) {
              message.before = sameEpoch
                .slice(Math.max(0, idx - contextCount), idx)
                .map(neighborSummary);
              message.after = sameEpoch
                .slice(idx + 1, idx + 1 + contextCount)
                .map(neighborSummary);
            }
          }

          return { ok: true, mode: "fetch", message };
        }

        // Mode B: Search by query (BM25 + substring, no regex)
        const query = args.query?.trim() ?? "";
        if (!query) {
          return {
            ok: false,
            error: "Provide a non-empty query to search or an id to fetch a message.",
          };
        }

        const queryTokens = tokenize(query);
        const lowerQuery = query.toLowerCase();
        const queryTerms = lowerQuery.split(/\s+/).filter((t) => t.length > 0);
        const searchableEntries = scopedEntries.filter((e) => e.toolName !== "search_transcript");
        const docTokenLists = searchableEntries.map((e) => tokenize(e.searchText));
        const stats = buildBM25StatsFromTokens(docTokenLists);

        const scored: { entry: IndexedTranscriptEntry; score: number }[] = [];
        for (let i = 0; i < searchableEntries.length; i++) {
          const entry = searchableEntries[i];
          const docTokens = docTokenLists[i];
          if (!entry || !docTokens) continue;

          const bm25 = bm25Score(queryTokens, docTokens, stats);
          const lowerDoc = entry.searchText.toLowerCase();
          const exactSub = lowerDoc.includes(lowerQuery) ? 5 : 0;
          let termSubCount = 0;
          for (const term of queryTerms) {
            if (lowerDoc.includes(term)) termSubCount++;
          }
          const score = bm25 + exactSub + termSubCount * 1.5;
          if (score > 0) {
            scored.push({ entry, score });
          }
        }

        scored.sort(
          (a, b) => b.score - a.score || b.entry.logPosition - a.entry.logPosition,
        );

        const limit = args.limit ?? 10;
        const matches: TranscriptSearchMatch[] = scored.slice(0, limit).map(({ entry, score }) => {
          const { snippet, truncated } = buildSnippet(entry.text, query);
          const match: TranscriptSearchMatch = {
            id: entry.id,
            resetEpoch: entry.resetEpoch,
            turnId: entry.turnId,
            kind: entry.kind,
            score: Math.round(score * 10000) / 10000,
            snippet,
            truncated,
            totalChars: entry.text.length,
            fetchHint: `search_transcript({ id: "${entry.id}" })`,
          };
          if (entry.toolName !== undefined) match.toolName = entry.toolName;
          if (entry.callId !== undefined) match.callId = entry.callId;
          if (entry.isError !== undefined) match.isError = entry.isError;
          if (entry.artifactId !== undefined) match.artifactId = entry.artifactId;
          return match;
        });

        return {
          ok: true,
          mode: "search",
          query,
          resetEpoch: currentResetEpoch,
          includePreviousResets,
          matchCount: matches.length,
          matches,
        };
      },
    }),
  };
}
