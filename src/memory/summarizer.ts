// ============================================================
// PRAANA Memory — Summarizer
//
// One LLM call per session end: "what did we learn?"
// No extract→consolidate→gate pipeline. Just ask.
// ============================================================

import { isMemoryKind } from "./types.js";
import type { ExtractedLearning, MemoryKind, SessionEvent, SummarizerLLM } from "./types.js";

const SYSTEM_PROMPT = `You are a memory extractor for a coding agent.
Your job: distill a session transcript into 0-5 learnings the agent will need in future sessions on this project.

## Output format
Output ONLY a JSON object. No prose, no markdown, no code fences.

{
  "learnings": [
    { "kind": "...", "content": "...", "certainty": "..." }
  ],
  "used_ids": []
}

## Learning kinds

- fact — verifiable project-specific knowledge
  good: "session log is events.jsonl, not current.log"
  bad: "TypeScript is a typed language"

- preference — user or team preference expressed in this session
  good: "user wants in-process rate limiting, no Redis"
  bad: "user likes clean code"

- decision — architectural or design choice made
  good: "chose sliding window over token bucket for /recall rate limiting"
  bad: "decided to use a rate limiter"

- pattern — recurring approach observed in this session
  good: "writes test first, then implementation"
  bad: "tests are important"

- mistake — error that occurred + root cause + fix
  good: "forgot to initialize timestamps Map in constructor → TypeError"
  bad: "there was a bug"

- constraint — hard rule or guardrail, often from user feedback
  good: "never use Redis for rate limiting — keep in-process only"
  bad: "be careful with dependencies"

## Rules

1. ONLY extract learnings grounded in this transcript. Do not hallucinate project facts not present here.
2. Each learning must be one clear sentence, max 120 chars.
3. Be conservative — return 0-3 if the session is routine. Return 5 only for rich sessions with decisions, bugs, and constraints.
4. certainty: high = stated explicitly or demonstrated clearly. medium = implied but not explicit. low = inferred with some uncertainty.
5. If nothing project-specific was learned, return { "learnings": [], "used_ids": [] }.

## used_ids
If the prompt includes a list of surfaced memory entries with IDs, list only those the agent clearly acted on (used in a tool call, referenced in a decision, or followed as advice). If none, return [].`;


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

export interface ExtractLearningsResult {
  learnings: ExtractedLearning[];
  usedIds: Set<string>;
}

export async function extractLearnings(
  llm: SummarizerLLM,
  events: SessionEvent[],
  surfaced?: Array<{ id: string; content: string }>,
): Promise<ExtractLearningsResult> {
  if (events.length === 0) return { learnings: [], usedIds: new Set() };
  if (!(await llm.available())) return { learnings: [], usedIds: new Set() };

  let prompt = transcriptToPrompt(events);
  if (surfaced && surfaced.length > 0) {
    prompt += "\n\n## Surfaced Memory Entries\n";
    for (const e of surfaced) {
      prompt += `- [${e.id}] ${e.content.slice(0, 120)}\n`;
    }
    prompt += "\nIdentify which of these surfaced entries were acted on.";
  }

  const raw = await llm.complete({
    system: SYSTEM_PROMPT,
    prompt,
    temperature: 0.3,
    maxTokens: 1500,
    json: true,
    timeoutMs: 30_000,
  });

  try {
    const parsed = JSON.parse(raw) as {
      learnings?: Array<{
        kind: string;
        content: string;
        certainty: string;
        scope_hints?: string[];
      }>;
      used_ids?: string[];
    };

    // Back-compat: handle the old array-only format (learnings as a top-level array)
    const rawLearnings = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.learnings)
        ? parsed.learnings
        : [];
    const learnings = rawLearnings
      .filter((p): p is typeof p & { kind: MemoryKind } => isMemoryKind(p.kind))
      .map((p) => ({
        kind: p.kind,
        content: p.content.slice(0, 200),
        certainty: (p.certainty === "high" || p.certainty === "medium" || p.certainty === "low")
          ? p.certainty
          : "medium",
        scope_hints: p.scope_hints,
      }));

    // Back-compat: also handle the old array-only format (used_ids defaults to empty)
    const usedIdsArr = Array.isArray(parsed.used_ids) ? parsed.used_ids : [];
    const usedIds = new Set(
      surfaced
        ? usedIdsArr.filter((id) => surfaced.some((s) => s.id === id))
        : usedIdsArr,
    );

    return { learnings, usedIds };
  } catch {
    return { learnings: [], usedIds: new Set() };
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
