// ============================================================
// ARIA Memory — Summarizer
//
// One LLM call per session end: "what did we learn?"
// No extract→consolidate→gate pipeline. Just ask.
// ============================================================

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

    const validKinds = new Set<MemoryKind>(["fact", "preference", "decision", "pattern", "mistake", "constraint"]);

    return parsed
      .filter((p) => validKinds.has(p.kind as MemoryKind))
      .map((p) => ({
        kind: p.kind as MemoryKind,
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
