import { defineTool } from "./tool-def.js";
import { z } from "zod";
import { buildArtifactCard } from "../context-engine/summarize.js";
import { buildPathChurnHint, buildRetrieveChurnHint } from "./read-churn.js";
import type { EventLog } from "../event-log.js";
import type { ContextEngine } from "../context-engine/index.js";
import type { ScorecardInc } from "../context-engine/telemetry.js";

export interface KnowledgeToolContext {
  eventLog: EventLog;
  contextEngine: ContextEngine | null;
  skillScorecard?: ScorecardInc;
  getCurrentTurn: () => number;
  getLastResetBoundaryTurn?: () => number;
}

function trackRetrievePathAccess(
  art: { sourceTool: string; command?: string },
  scorecard?: ScorecardInc,
): string | undefined {
  if (art.sourceTool !== "read_file" || !art.command || !scorecard?.trackFileAccess) {
    return undefined;
  }
  const outcome = scorecard.trackFileAccess(art.command, "retrieve");
  if (!outcome.shouldIntervene) return undefined;
  const channels = scorecard.getFileAccessChannels?.(art.command) ?? ["retrieve"];
  return buildPathChurnHint(art.command, outcome.count, channels);
}

export function createKnowledgeTools(ctx: KnowledgeToolContext) {
  const { eventLog, contextEngine, getCurrentTurn } = ctx;

  const searchTurnEvents = contextEngine
    ? {
        search_turn_events: defineTool({
          description:
            "Search the structured turn ledger for this session using BM25 ranking. " +
            "Returns turn summaries with artifact IDs, files touched, and errors — faster than scanning raw events.jsonl.",
          parameters: z.object({
            query: z.string().describe("Search query"),
            limit: z
              .number()
              .int()
              .min(1)
              .max(50)
              .default(20)
              .describe("Max matches to return"),
          }),
          execute: async ({ query, limit }) => {
            const matches = contextEngine.searchTurnEvents(
              query,
              limit ?? 20,
              getCurrentTurn(),
              ctx.getLastResetBoundaryTurn?.() ?? -1,
            );
            ctx.skillScorecard?.inc("turnEventSearches");
            eventLog.append({
              kind: "system_note",
              actor: "kernel",
              payload: {
                type: "turn_ledger_search",
                query,
                hits: matches.length,
              },
            });
            return {
              ok: true,
              query,
              matchCount: matches.length,
              matches,
            };
          },
        }),
      }
    : {};

  const contextSummary = contextEngine
    ? {
        context_summary: defineTool({
          description:
            "Return the current session checkpoint summary: active intent, recent decisions, open errors, and recent activity.",
          parameters: z.object({}),
          execute: async () => {
            const summary = contextEngine.renderContextSummary();
            eventLog.append({
              kind: "system_note",
              actor: "kernel",
              payload: { type: "context_summary" },
            });
            return { ok: true, summary };
          },
        }),
      }
    : {};

  const retrieveArtifact = contextEngine
    ? {
        retrieve_artifact: defineTool({
          description:
            "Retrieve the full raw content of a stored tool-output artifact by ID. Use when an artifact card in the prompt is insufficient.",
          parameters: z.object({
            id: z.string().describe("Artifact ID (e.g. art_abc123def456)"),
            grep: z.string().optional().describe("Keep only lines matching this regex"),
            lineStart: z.number().int().positive().optional().describe("First line to return (1-based)"),
            lineEnd: z.number().int().positive().optional().describe("Last line to return (1-based)"),
            jsonPath: z.string().optional().describe("Extract a value from JSON content (dot-separated path)"),
          }),
          execute: async ({ id, grep, lineStart, lineEnd, jsonPath }) => {
            const params = { grep, lineStart, lineEnd, jsonPath };
            const priorCount =
              ctx.skillScorecard?.getArtifactRetrieveCount?.(id, params) ?? 0;

            // Identical successful retry (same id + filters) → deterministic
            // card without retrieveArtifact side effects (access_count /
            // lastAccessedTurn / recordArtifactAccess). Failed keys are never
            // recorded, so this path only runs after a prior success (#571).
            if (priorCount >= 1) {
              const art = contextEngine.getArtifact(id);
              if (art) {
                const track = ctx.skillScorecard?.trackArtifactRetrieve?.(id, params);
                ctx.skillScorecard?.inc("artifactRetrieveCalls");
                const pathWarning = trackRetrievePathAccess(art, ctx.skillScorecard);
                const warning = [
                  buildRetrieveChurnHint(id, track?.count ?? priorCount + 1),
                  pathWarning,
                ].filter(Boolean).join("\n") || undefined;
                eventLog.append({
                  kind: "system_note",
                  actor: "kernel",
                  payload: {
                    type: "artifact_retrieve_retry",
                    id,
                    grep: grep ?? null,
                    lineStart: lineStart ?? null,
                    lineEnd: lineEnd ?? null,
                    jsonPath: jsonPath ?? null,
                    count: track?.count ?? 0,
                  },
                });
                return {
                  ok: true,
                  id,
                  content: buildArtifactCard(
                    art.id,
                    art.sourceTool,
                    art.command,
                    art.rawTokens,
                    {
                      sourceLineStart: art.sourceLineStart,
                      sourceLineEnd: art.sourceLineEnd,
                      sourceTotalLines: art.sourceTotalLines,
                      sourceCapped: art.sourceCapped,
                      sourceLongLinesCut: art.sourceLongLinesCut,
                    },
                  ),
                  warning,
                  skipped_payload: true,
                  original_turn: art.createdTurn,
                };
              }
            }

            const retrieved = contextEngine.retrieveArtifact(
              id,
              getCurrentTurn(),
              params,
            );
            if (!retrieved.ok) {
              return { ok: false, error: retrieved.error };
            }

            ctx.skillScorecard?.trackArtifactRetrieve?.(id, params);
            ctx.skillScorecard?.inc("artifactRetrieveCalls");

            const art = contextEngine.getArtifact(id);
            const pathWarning = art
              ? trackRetrievePathAccess(art, ctx.skillScorecard)
              : undefined;

            eventLog.append({
              kind: "system_note",
              actor: "kernel",
              payload: {
                type: "artifact_retrieve",
                id,
                grep: grep ?? null,
                lineStart: lineStart ?? null,
                lineEnd: lineEnd ?? null,
                jsonPath: jsonPath ?? null,
              },
            });

            return {
              ok: true,
              id,
              content: retrieved.content,
              ...(retrieved.total_lines !== undefined ? { total_lines: retrieved.total_lines } : {}),
              ...(retrieved.line_start !== undefined ? { line_start: retrieved.line_start } : {}),
              ...(retrieved.line_end !== undefined ? { line_end: retrieved.line_end } : {}),
              ...(retrieved.truncated ? { truncated: true as const } : {}),
              ...(retrieved.next_offset !== undefined ? { next_offset: retrieved.next_offset } : {}),
              ...(retrieved.note ? { note: retrieved.note } : {}),
              ...(pathWarning ? { warning: pathWarning } : {}),
            };
          },
        }),
      }
    : {};

  const eventLineage = contextEngine
    ? {
        event_lineage: defineTool({
          description:
            "Trace an artifact back to the turn, tool call, decisions, and related artifacts/files that produced or used it.",
          parameters: z.object({
            artifactId: z.string().describe("Artifact ID (e.g. art_abc123def456)"),
          }),
          execute: async ({ artifactId }) => {
            const result = contextEngine.eventLineage(artifactId, getCurrentTurn());
            if (!result.ok) {
              return { ok: false, error: result.error };
            }

            eventLog.append({
              kind: "system_note",
              actor: "kernel",
              payload: {
                type: "event_lineage",
                artifactId,
                producedTurn: result.lineage.producedTurn,
              },
            });

            return {
              ok: true,
              lineage: result.lineage,
              text: result.text,
            };
          },
        }),
      }
    : {};

  return {
    ...searchTurnEvents,
    ...contextSummary,
    ...retrieveArtifact,
    ...eventLineage,
  };
}
