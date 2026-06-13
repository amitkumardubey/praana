import { defineTool } from "./tool-def.js";
import { z } from "zod";
import type { MemoryStore } from "../memory/index.js";
import type { EventLog } from "../event-log.js";
import type { ContextEngine } from "../context-engine/index.js";

export interface KnowledgeToolContext {
  eventLog: EventLog;
  memoryStore: MemoryStore | null;
  memoryEnabled: boolean;
  incognito: boolean;
  contextEngine: ContextEngine | null;
  getCurrentTurn: () => number;
}

export function createKnowledgeTools(ctx: KnowledgeToolContext) {
  const { eventLog, memoryStore, memoryEnabled, incognito, contextEngine, getCurrentTurn } = ctx;

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
            );
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
            const retrieved = contextEngine.retrieveArtifact(id, getCurrentTurn(), {
              grep,
              lineStart,
              lineEnd,
              jsonPath,
            });
            if (!retrieved.ok) {
              return { ok: false, error: retrieved.error };
            }

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

            return { ok: true, id, content: retrieved.content };
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
    recall: defineTool({
      description:
        "Search your cross-session memory for past learnings, decisions, preferences, or patterns. Use when you need context from previous sessions.",
      parameters: z.object({
        query: z.string().describe("Search query"),
        mode: z
          .enum(["standard", "causal_chain"])
          .optional()
          .describe("Search mode"),
        kinds: z
          .array(z.string())
          .optional()
          .describe("Filter by kinds (fact, preference, decision, pattern, mistake, constraint)"),
      }),
      execute: async ({ query, kinds }) => {
        if (!memoryEnabled || !memoryStore) {
          return {
            ok: false,
            error: incognito
              ? "Incognito mode is active — cross-session memory is disabled for this session."
              : "Cross-session memory is not available.",
          };
        }

        try {
          const result = await memoryStore.recall(query, { limit: 10, kinds: kinds as any });

          eventLog.append({
            kind: "system_note",
            actor: "kernel",
            payload: {
              type: "memory_recall",
              query,
              hits: result.entries.length,
            },
          });

          if (result.entries.length === 0) {
            return {
              ok: true,
              entries: [],
              note:
                "No cross-session matches. If this was discussed earlier in this same session, use search_session_log(query, kinds?, limit?) to recover it from events.jsonl.",
            };
          }

          return { ok: true, entries: result.entries };
        } catch (err: any) {
          const message = err?.message ?? "Recall failed";
          return {
            ok: false,
            error:
              `${message}. For same-session history, use search_session_log(query, kinds?, limit?) instead of recall.`,
          };
        }
      },
    }),

    remember: defineTool({
      description:
        "Store a fact, preference, decision, mistake, or pattern in your cross-session memory for future sessions.",
      parameters: z.object({
        content: z.string().describe("What to remember"),
        kind: z
          .enum(["preference", "context_fact", "decision", "mistake", "pattern", "fact", "constraint"])
          .optional()
          .describe("Type of knowledge"),
        certainty: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("How certain you are"),
        scope: z
          .array(z.string())
          .optional()
          .describe("Scope labels to isolate this memory (e.g. ['context:my-project']). Defaults to automatic scopes."),
      }),
      execute: async ({ content, kind, certainty, scope }) => {
        if (!memoryEnabled || !memoryStore) {
          return {
            ok: false,
            error: incognito
              ? "Incognito mode is active — cross-session memory writes are disabled."
              : "Cross-session memory is not available.",
          };
        }

        try {
          // Map legacy kind aliases to our kinds
          const mappedKind =
            kind === "context_fact" ? "fact" :
            (kind as any) ?? "fact";

          const result = await memoryStore.remember(content, {
            kind: mappedKind as any,
            certainty: certainty ?? "medium",
            scope: scope ?? undefined,
          });

          return { ok: true, id: result.id };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Remember failed" };
        }
      },
    }),

    ...searchTurnEvents,
    ...contextSummary,
    ...retrieveArtifact,
    ...eventLineage,

    forget_memory: defineTool({
      description: "Retract (tombstone) a cross-session memory entry. The memory is excluded from future recall and digest, but retained for audit.",
      parameters: z.object({
        id: z.string().describe("Memory entry ID to retract"),
      }),
      execute: async ({ id }) => {
        if (incognito) {
          return {
            ok: false,
            error: "Memory is disabled in incognito mode.",
          };
        }
        if (!memoryEnabled || !memoryStore) {
          return {
            ok: false,
            error: "Cross-session memory is not available.",
          };
        }
        try {
          if (!memoryStore.hasEntry(id)) {
            return { ok: false, error: `Memory ${id} not found` };
          }
          memoryStore.retractMemory(id);
          eventLog.append({
            kind: "system_note",
            actor: "kernel",
            payload: { type: "memory_forget", id },
          });
          return { ok: true, id };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Forget failed" };
        }
      },
    }),
  };
}
