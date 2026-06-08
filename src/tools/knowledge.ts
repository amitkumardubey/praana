import { defineTool } from "./tool-def.js";
import { z } from "zod";
import type { MemoryStore } from "../memory/index.js";
import type { EventLog } from "../event-log.js";

export interface KnowledgeToolContext {
  eventLog: EventLog;
  memoryStore: MemoryStore | null;
  memoryEnabled: boolean;
  incognito: boolean;
}

export function createKnowledgeTools(ctx: KnowledgeToolContext) {
  const { eventLog, memoryStore, memoryEnabled, incognito } = ctx;

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
          // Map bodha-style kinds to our kinds
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
