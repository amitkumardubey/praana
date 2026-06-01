import { defineTool } from "./tool-def.js";
import { z } from "zod";
import type { EventLog } from "../event-log.js";
import type { StateGraph } from "../state-graph.js";

export interface MemoryToolContext {
  eventLog: EventLog;
  stateGraph: StateGraph;
}

export function createMemoryTools(ctx: MemoryToolContext) {
  const { eventLog, stateGraph } = ctx;

  const logAction = (
    action: string,
    payload: Record<string, unknown>
  ) => {
    eventLog.append({
      kind: "context_action",
      actor: "kernel",
      payload: { action, ...payload },
    });
  };

  return {
    create_task: defineTool({
      description: "Create a new task in working memory. Tasks track what you're working on.",
      parameters: z.object({
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Optional details"),
      }),
      execute: async ({ title, description }) => {
        const obj = stateGraph.create("task", {
          title,
          description,
          status: "todo",
        });
        logAction("create", {
          id: obj.id,
          kind: "task",
          tier: obj.tier,
          statePayload: obj.payload,
          created: obj.created,
          updated: obj.updated,
          lastTouched: obj.lastTouched,
        });
        return { ok: true, id: obj.id };
      },
    }),

    complete_task: defineTool({
      description: "Mark a task as done. Use when you've completed a task.",
      parameters: z.object({
        id: z.string().describe("Task ID to complete"),
      }),
      execute: async ({ id }) => {
        const obj = stateGraph.get(id);
        if (!obj || obj.kind !== "task") {
          return { ok: false, error: `Task ${id} not found` };
        }
        const updated = stateGraph.update(id, { status: "done" });
        if (updated) {
          logAction("update", {
            id,
            statePayload: { status: "done" },
            updated: updated.updated,
            lastTouched: updated.lastTouched,
          });
        }
        // Auto-soft-unload on complete_task
        stateGraph.setTier(id, "soft");
        logAction("setTier", {
          id,
          tier: "soft",
          lastTouched: stateGraph.get(id)!.lastTouched,
        });
        return { ok: true };
      },
    }),

    add_constraint: defineTool({
      description:
        "Add a constraint to working memory. Use for rules, limitations, or requirements to keep in mind.",
      parameters: z.object({
        text: z.string().describe("The constraint text"),
      }),
      execute: async ({ text }) => {
        const obj = stateGraph.create("constraint", { text });
        logAction("create", {
          id: obj.id,
          kind: "constraint",
          tier: obj.tier,
          statePayload: obj.payload,
          created: obj.created,
          updated: obj.updated,
          lastTouched: obj.lastTouched,
        });
        return { ok: true, id: obj.id };
      },
    }),

    decide: defineTool({
      description:
        "Record a decision in working memory with its rationale.",
      parameters: z.object({
        summary: z.string().describe("Short summary of the decision"),
        rationale: z.string().describe("Why this decision was made"),
      }),
      execute: async ({ summary, rationale }) => {
        const obj = stateGraph.create("decision", {
          summary,
          rationale,
        });
        logAction("create", {
          id: obj.id,
          kind: "decision",
          tier: obj.tier,
          statePayload: obj.payload,
          created: obj.created,
          updated: obj.updated,
          lastTouched: obj.lastTouched,
        });
        return { ok: true, id: obj.id };
      },
    }),

    add_note: defineTool({
      description:
        "Add a general note to working memory. Capture semantic findings (facts, behavior, decisions) — not activity logs or file lists. After significant analysis, add notes immediately so findings survive context truncation.",
      parameters: z.object({
        text: z.string().describe("The note text — a finding or fact, not a list of files read"),
      }),
      execute: async ({ text }) => {
        const qualityWarning = detectActivityLogNote(text);
        const obj = stateGraph.create("note", { text });
        logAction("create", {
          id: obj.id,
          kind: "note",
          tier: obj.tier,
          statePayload: obj.payload,
          created: obj.created,
          updated: obj.updated,
          lastTouched: obj.lastTouched,
        });
        return qualityWarning
          ? { ok: true, id: obj.id, warning: qualityWarning }
          : { ok: true, id: obj.id };
      },
    }),

    soft_unload: defineTool({
      description:
        "Demote a state object to the soft tier (shown as one-line stub in memory). Use when something is less relevant now.",
      parameters: z.object({
        id: z.string().describe("Object ID to demote"),
      }),
      execute: async ({ id }) => {
        const obj = stateGraph.get(id);
        if (!obj) return { ok: false, error: `Object ${id} not found` };
        stateGraph.setTier(id, "soft");
        logAction("setTier", {
          id,
          tier: "soft",
          lastTouched: stateGraph.get(id)!.lastTouched,
        });
        return { ok: true };
      },
    }),

    hard_unload: defineTool({
      description:
        "Demote a state object to the hard tier (shown as minimal anchor in memory). Use when something is even less relevant.",
      parameters: z.object({
        id: z.string().describe("Object ID to demote to hard"),
      }),
      execute: async ({ id }) => {
        const obj = stateGraph.get(id);
        if (!obj) return { ok: false, error: `Object ${id} not found` };
        stateGraph.setTier(id, "hard");
        logAction("setTier", {
          id,
          tier: "hard",
          lastTouched: stateGraph.get(id)!.lastTouched,
        });
        return { ok: true };
      },
    }),

    hydrate: defineTool({
      description:
        "Promote a peripheral (soft/hard) object back to active memory, restoring its full content.",
      parameters: z.object({
        id: z.string().describe("Object ID to hydrate"),
      }),
      execute: async ({ id }) => {
        const obj = stateGraph.get(id);
        if (!obj) return { ok: false, error: `Object ${id} not found` };
        stateGraph.setTier(id, "active");
        logAction("setTier", {
          id,
          tier: "active",
          lastTouched: stateGraph.get(id)!.lastTouched,
        });
        return { ok: true, payload: obj.payload as unknown as Record<string, unknown> };
      },
    }),

    list_state: defineTool({
      description: "List all state objects with their id, kind, tier, and summary.",
      parameters: z.object({}),
      execute: async () => {
        const objects = stateGraph.list();
        return { ok: true, objects };
      },
    }),

    focus_task: defineTool({
      description:
        "Pin a task (or any state object) as the current focus. Focused objects render first in active state.",
      parameters: z.object({
        id: z.string().describe("Object ID to focus"),
      }),
      execute: async ({ id }) => {
        const obj = stateGraph.get(id);
        if (!obj) return { ok: false, error: `Object ${id} not found` };
        stateGraph.setFocus(id);
        logAction("setFocus", {
          id,
          lastTouched: stateGraph.get(id)!.lastTouched,
        });
        return { ok: true, id };
      },
    }),

    search_session_log: defineTool({
      description:
        "Search the current session's event log for earlier messages, tool calls, and results. " +
        "Use this to recover in-session context (e.g. a code review from earlier turns) — not recall, which only searches cross-session memory. " +
        "Session log path: events.jsonl",
      parameters: z.object({
        query: z
          .string()
          .describe(
            "Search terms (ANDed, case-insensitive). Use | for OR, e.g. 'issue|review'"
          ),
        kinds: z
          .array(
            z.enum([
              "user_message",
              "agent_message",
              "tool_call",
              "tool_result",
              "context_action",
              "system_note",
            ])
          )
          .optional()
          .describe("Optional event kinds to filter"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Max matches to return"),
      }),
      execute: async ({ query, kinds, limit }) => {
        const matches = eventLog.search(query, { kinds, limit: limit ?? 20 });
        return {
          ok: true,
          query,
          matchCount: matches.length,
          matches: matches.map(({ event, excerpt }) => ({
            event_id: event.event_id,
            kind: event.kind,
            actor: event.actor,
            timestamp: event.timestamp,
            excerpt,
          })),
        };
      },
    }),
  };
}

/** Warn when a note looks like an activity log instead of a semantic finding. */
export function detectActivityLogNote(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 20) return null;

  const fileListPattern = /(?:read|analyzed|reviewed|checked).{0,40}(?:src\/|\b[\w.-]+\.(?:ts|js|tsx|jsx|py|go|rs)\b)/i;
  const commaFileRun = /(?:src\/[\w./-]+(?:,\s*|\s+and\s+)){2,}/i;
  const lacksFindingLanguage = !/\b(uses|implements|returns|calls|handles|because|found|decided|pattern|via|is a|are stored)\b/i.test(trimmed);

  if ((fileListPattern.test(trimmed) || commaFileRun.test(trimmed)) && lacksFindingLanguage) {
    return "This note looks like an activity log. Prefer a semantic finding (what you learned), not which files you read.";
  }
  return null;
}