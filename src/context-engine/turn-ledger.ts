import type { Database } from "bun:sqlite";
import type { Event } from "../types.js";
import {
  getMaxLedgerTurn,
  getTurnRecord,
  hasLedgerTurn,
  insertTurnRecord,
  listArtifactIdsForTurn,
  listTurnRecords,
} from "./db.js";
import {
  buildTurnSearchText,
  extractFilePathsFromTool,
  extractToolError,
  TurnRecorder,
} from "./turn-recorder.js";
import { bm25Score, tokenize, buildBM25Stats } from "./bm25.js";
import type { ToolCallRecord, TurnRecord, TurnSearchMatch } from "./types.js";

function buildExcerpt(record: TurnRecord, maxLen = 400): string {
  const text = [
    record.userMessage,
    record.assistantMessage,
    ...record.errors,
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function pairToolCalls(events: Event[]): ToolCallRecord[] {
  const calls: ToolCallRecord[] = [];
  const pending: Array<{ tool: string; args: Record<string, unknown> }> = [];

  for (const ev of events) {
    if (ev.kind === "tool_call") {
      pending.push({
        tool: String(ev.payload.tool ?? ""),
        args: (ev.payload.args as Record<string, unknown>) ?? {},
      });
      continue;
    }
    if (ev.kind !== "tool_result") continue;

    const tool = String(ev.payload.tool ?? "");
    const idx = pending.findIndex((p) => p.tool === tool);
    const call = idx >= 0 ? pending.splice(idx, 1)[0] : { tool, args: {} };
    const result = ev.payload.result;
    const isError =
      !!result &&
      typeof result === "object" &&
      (("ok" in result && (result as { ok?: unknown }).ok === false) ||
        "error" in result);

    calls.push({
      tool: call.tool,
      args: call.args,
      isError,
    });
  }

  return calls;
}

function collectFilesAndErrors(
  toolCalls: ToolCallRecord[],
  events: Event[],
): { filesRead: string[]; filesWritten: string[]; errors: string[] } {
  const filesRead = new Set<string>();
  const filesWritten = new Set<string>();
  const errors: string[] = [];

  for (const tc of toolCalls) {
    const paths = extractFilePathsFromTool(tc.tool, tc.args);
    if (paths.read) filesRead.add(paths.read);
    if (paths.written) filesWritten.add(paths.written);
  }

  for (const ev of events) {
    if (ev.kind !== "tool_result") continue;
    const result = ev.payload.result;
    const err = extractToolError(result, false);
    if (err) errors.push(err);
  }

  return {
    filesRead: [...filesRead],
    filesWritten: [...filesWritten],
    errors,
  };
}

export function groupEventsIntoTurns(
  events: Event[],
): Array<{ userMessage: string; events: Event[] }> {
  const turns: Array<{ userMessage: string; events: Event[] }> = [];
  let current: { userMessage: string; events: Event[] } | null = null;

  for (const ev of events) {
    if (ev.kind === "user_message") {
      if (current) turns.push(current);
      current = {
        userMessage: String(ev.payload.text ?? ""),
        events: [],
      };
      continue;
    }
    if (!current) continue;
    current.events.push(ev);
  }

  if (current) turns.push(current);
  return turns;
}

export class TurnLedger {
  constructor(
    private readonly db: Database,
    private readonly sessionId: string,
  ) {}

  append(record: TurnRecord): void {
    if (hasLedgerTurn(this.db, this.sessionId, record.turn)) return;
    insertTurnRecord(this.db, this.sessionId, record, buildTurnSearchText(record));
  }

  get(turn: number): TurnRecord | null {
    return getTurnRecord(this.db, this.sessionId, turn);
  }

  list(): TurnRecord[] {
    return listTurnRecords(this.db, this.sessionId);
  }

  getMaxTurn(): number | null {
    return getMaxLedgerTurn(this.db, this.sessionId);
  }

  migrateFromEvents(events: Event[]): number {
    const grouped = groupEventsIntoTurns(events);
    let inserted = 0;

    grouped.forEach((group, turnIndex) => {
      if (hasLedgerTurn(this.db, this.sessionId, turnIndex)) return;

      const assistantMessage =
        group.events
          .filter((e) => e.kind === "agent_message")
          .map((e) => String(e.payload.text ?? ""))
          .join("\n") || "";

      const turnEvents = group.events.filter(
        (e) => e.kind === "tool_call" || e.kind === "tool_result",
      );
      const toolCalls = pairToolCalls(turnEvents);
      const { filesRead, filesWritten, errors } = collectFilesAndErrors(
        toolCalls,
        group.events,
      );

      const artifactIds = listArtifactIdsForTurn(this.db, this.sessionId, turnIndex);

      const record: TurnRecord = {
        turn: turnIndex,
        userMessage: group.userMessage,
        assistantMessage,
        toolCalls,
        artifactIds,
        filesRead,
        filesWritten,
        errors,
        tokenCount: 0,
        timestamp:
          group.events[group.events.length - 1]?.timestamp ?? Date.now(),
      };

      insertTurnRecord(this.db, this.sessionId, record, buildTurnSearchText(record));
      inserted++;
    });

    return inserted;
  }

  search(query: string, limit = 20): TurnSearchMatch[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const records = this.list();
    if (records.length === 0) return [];

    const queryTokens = tokenize(trimmed);
    if (queryTokens.length === 0) return [];

    const docTexts = records.map((r) => buildTurnSearchText(r));
    const stats = buildBM25Stats(docTexts);
    const docTokenLists = docTexts.map((d) => tokenize(d));

    const scored = records
      .map((record, i) => ({
        record,
        score: bm25Score(queryTokens, docTokenLists[i], stats),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(({ record, score }) => ({
      turn: record.turn,
      score,
      userMessage: record.userMessage,
      assistantMessage: record.assistantMessage,
      excerpt: buildExcerpt(record),
      artifactIds: record.artifactIds,
      filesRead: record.filesRead,
      filesWritten: record.filesWritten,
      errors: record.errors,
      timestamp: record.timestamp,
    }));
  }
}
