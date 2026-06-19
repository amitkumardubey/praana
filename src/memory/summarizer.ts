// ============================================================
// PRAANA Memory — Summarizer
//
// One LLM call per session end: "what did we learn?"
// No extract→consolidate→gate pipeline. Just ask.
// ============================================================

import { isMemoryKind } from "./types.js";
import type { ExtractedLearning, MemoryKind, SessionEvent, SummarizerLLM } from "./types.js";

const SYSTEM_PROMPT = `You are a memory extractor for a coding agent.
Given a session transcript, extract 0-5 concise learnings.
Output ONLY a JSON array. No prose outside the array.

Each entry: { "kind": "fact" | "preference" | "decision" | "pattern" | "mistake" | "constraint", "content": "...", "certainty": "high" | "medium" | "low" }

Rules:
- "fact": verifiable project knowledge ("uses Vitest for testing")
- "preference": user or agent preference ("prefers dark mode UI")
- "decision": architectural choice ("chose JWT over session cookies")
- "pattern": recurring approach ("validates with Zod before DB writes")
- "mistake": failure + lesson learned ("forgot await on verify() → 401s")
- "constraint": hard rule ("never commits .env files")
- Be conservative. Skip vague or low-signal items.
- Content should be one sentence, max 120 characters.
- certainty reflects how strongly the transcript supports this.`;

const UTILITY_PROMPT = `You are a memory utility judge for a coding agent.
Given a session transcript and a list of memory entries that were surfaced (recall results),
identify which surfaced entries the agent actually **acted on** during the session.

An entry was "acted on" if:
- The agent used the information to make a decision or take an action
- The agent followed the advice/preference/constraint
- The agent referenced the fact in a tool call or response
- The entry directly informed a successful action

Output ONLY a JSON object with one key. No prose outside the object.

{
  "used_ids": ["entry-id-1", "entry-id-2"]
}

Include only IDs from the surfaced list. Be conservative — only include entries clearly acted on.
If none were acted on, return an empty array.`;

function transcriptToPrompt(events: SessionEvent[]): string {
  const lines: string[] = ["Session transcript:"];
  for (const e of events) {
    if (e.type === "user_message") lines.push(`User: ${e.content}`);
    else if (e.type === "agent_message") lines.push(`Agent: ${e.content}`);
    else if (e.type === "tool_use") lines.push(`[tool] ${e.tool_name}(${JSON.stringify(e.args ?? {})})`);
    else if (e.type === "tool_result") lines.push(`[result] ${JSON.stringify(e.result).slice(0, 200)}`);
  }
  return lines.join("\n");
}

export async function extractLearnings(
  llm: SummarizerLLM,
  events: SessionEvent[],
): Promise<ExtractedLearning[]> {
  if (events.length === 0) return [];
  if (!(await llm.available())) return [];

  const raw = await llm.complete({
    system: SYSTEM_PROMPT,
    prompt: transcriptToPrompt(events),
    temperature: 0.3,
    maxTokens: 1500,
    json: true,
    timeoutMs: 30_000,
  });

  try {
    const parsed = JSON.parse(raw) as Array<{
      kind: string;
      content: string;
      certainty: string;
      scope_hints?: string[];
    }>;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((p): p is typeof p & { kind: MemoryKind } => isMemoryKind(p.kind))
      .map((p) => ({
        kind: p.kind,
        content: p.content.slice(0, 200),
        certainty: (p.certainty === "high" || p.certainty === "medium" || p.certainty === "low")
          ? p.certainty
          : "medium",
        scope_hints: p.scope_hints,
      }));
  } catch {
    return [];
  }
}

/**
 * Ask the summarizer to identify which surfaced recall entries were actually
 * acted on during the session. Returns the set of acted-on entry IDs.
 */
export async function extractUsedEntryIds(
  llm: SummarizerLLM,
  events: SessionEvent[],
  surfaced: Array<{ id: string; content: string }>,
): Promise<Set<string>> {
  if (surfaced.length === 0) return new Set();
  if (events.length === 0) return new Set();
  if (!(await llm.available())) return new Set();

  let prompt = transcriptToPrompt(events);
  prompt += "\n\n## Surfaced Memory Entries\n";
  for (const e of surfaced) {
    prompt += `- [${e.id}] ${e.content.slice(0, 120)}\n`;
  }
  prompt += "\nIdentify which of these surfaced entries were acted on.";

  try {
    const raw = await llm.complete({
      system: UTILITY_PROMPT,
      prompt,
      temperature: 0.2,
      maxTokens: 500,
      json: true,
      timeoutMs: 20_000,
    });

    const parsed = JSON.parse(raw) as { used_ids?: string[] };
    if (!Array.isArray(parsed.used_ids)) return new Set();

    const surfacedIdSet = new Set(surfaced.map((s) => s.id));
    return new Set(
      parsed.used_ids.filter((id: string) => surfacedIdSet.has(id)),
    );
  } catch {
    return new Set();
  }
}

/**
 * Fallback heuristic when no summarizer is available: term co-occurrence
 * between surfaced entry content and tool-call args/results in the events.
 * Returns entry IDs that have at least one significant term match.
 */
export function usedIdsByCooccurrence(
  events: SessionEvent[],
  surfaced: Array<{ id: string; content: string }>,
): Set<string> {
  if (surfaced.length === 0) return new Set();

  // Collect all tool-call args and results text
  const toolTexts: string[] = [];
  for (const e of events) {
    if (e.type === "tool_use" && e.args) {
      toolTexts.push(JSON.stringify(e.args));
    } else if (e.type === "tool_result" && e.result !== undefined) {
      toolTexts.push(typeof e.result === "string" ? e.result : JSON.stringify(e.result));
    }
  }

  const corpus = toolTexts.join(" ").toLowerCase();
  if (!corpus) return new Set();

  const used = new Set<string>();
  for (const entry of surfaced) {
    const terms = entry.content
      .toLowerCase()
      .match(/[a-z0-9_]{3,}/g) ?? [];
    // Entry is "used" if ≥2 significant content terms appear in tool text
    const matches = terms.filter((t) => corpus.includes(t));
    if (matches.length >= 2) {
      used.add(entry.id);
    }
  }

  return used;
}

const TURN_COMPRESSION_PROMPT = `You are a memory compressor for a coding agent.
Given a batch of old conversation turns, extract 1-5 concise episodic facts.
Output ONLY a JSON array. No prose outside the array.

Each entry: { "kind": "fact" | "pattern" | "decision", "content": "...", "certainty": "high" | "medium" | "low" }

Rules:
- Focus on verifiable facts, patterns, and decisions — not activity logs.
- Content should be one sentence, max 120 characters.
- Be conservative. Skip vague or low-signal items.
- These memories will replace the raw turns in the agent's context.`;

/** Summarize a batch of old turns into episodic memories for history compression. */
export async function summarizeTurns(
  llm: SummarizerLLM,
  events: SessionEvent[],
): Promise<ExtractedLearning[]> {
  if (events.length === 0) return [];
  if (!(await llm.available())) return [];

  const raw = await llm.complete({
    system: TURN_COMPRESSION_PROMPT,
    prompt: transcriptToPrompt(events),
    temperature: 0.3,
    maxTokens: 1000,
    json: true,
    timeoutMs: 30_000,
  });

  try {
    const parsed = JSON.parse(raw) as Array<{
      kind: string;
      content: string;
      certainty: string;
    }>;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((p): p is typeof p & { kind: MemoryKind } => isMemoryKind(p.kind))
      .map((p) => ({
        kind: p.kind,
        content: p.content.slice(0, 200),
        certainty: (p.certainty === "high" || p.certainty === "medium" || p.certainty === "low")
          ? p.certainty
          : "medium",
      }));
  } catch {
    return [];
  }
}