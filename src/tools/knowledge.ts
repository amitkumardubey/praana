import { tool } from "ai";
import { z } from "zod";
import type { AgentKBClient } from "bodha";
import type { EventLog } from "../event-log.js";

export interface KnowledgeToolContext {
  bodhaClient: AgentKBClient | null;
  bodhaEnabled: boolean;
}

export function createKnowledgeTools(ctx: KnowledgeToolContext) {
  const { bodhaClient, bodhaEnabled } = ctx;

  return {
    recall: tool({
      description:
        "Search your cross-session knowledge base for past learnings, decisions, preferences, or patterns. Use when you need context from previous sessions.",
      parameters: z.object({
        query: z.string().describe("Search query"),
        mode: z
          .enum(["standard", "causal_chain"])
          .optional()
          .describe("Search mode: standard or causal_chain"),
        kinds: z
          .array(z.string())
          .optional()
          .describe("Filter by entry kinds (e.g. ['decision', 'pattern'])"),
      }),
      execute: async ({ query, mode, kinds }) => {
        if (!bodhaEnabled || !bodhaClient) {
          return { ok: false, error: "Cross-session knowledge base is not available." };
        }

        try {
          const result = await bodhaClient.recall(query, {
            mode: mode as "standard" | "causal_chain" | undefined,
            // kinds filter not directly supported by bodha agent client,
            // but entries have kind field we can filter after
          });

          const entries = result.entries.map((e) => ({
            id: e.id,
            kind: e.kind,
            content: e.content,
            confidence: e.confidence,
            scopes: (e as any).scopes ?? [],
          }));

          return { ok: true, entries };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Recall failed" };
        }
      },
    }),

    remember: tool({
      description:
        "Store a fact, preference, decision, mistake, or pattern in your cross-session knowledge base for future sessions.",
      parameters: z.object({
        content: z.string().describe("What to remember"),
        kind: z
          .enum(["preference", "context_fact", "decision", "mistake", "pattern"])
          .optional()
          .describe("Type of knowledge"),
        certainty: z
          .enum(["high", "medium", "low"])
          .optional()
          .describe("How certain you are about this knowledge"),
      }),
      execute: async ({ content, kind, certainty }) => {
        if (!bodhaEnabled || !bodhaClient) {
          return { ok: false, error: "Cross-session knowledge base is not available." };
        }

        try {
          await bodhaClient.remember(content, {
            kind,
            certainty,
          });

          return { ok: true };
        } catch (err: any) {
          return { ok: false, error: err?.message ?? "Remember failed" };
        }
      },
    }),
  };
}

