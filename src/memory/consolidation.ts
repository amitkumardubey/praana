// ============================================================
// PRAANA Memory — Consolidation Processor
//
// Background learning loop: re-evaluates session learnings,
// cross-checks against existing Layer 1 entries, and promotes
// confirmed patterns to Layer 2 (deep memory).
// ============================================================

import type { MemoryEntry, MemoryKind, SessionEvent, SummarizerLLM } from "./types.js";
import type { MemoryStore } from "./store.js";
import { effectiveValidity } from "./confidence.js";
import { getAppLogger } from "../logger.js";

export interface ConsolidationConfig {
  enabled: boolean;
  model?: string;
  promotion_threshold: number;  // confirmation_count >= this to promote
  run_delay_seconds: number;
}

export interface ConsolidationResult {
  promotions: number;
  confirmations: number;
  contradictions: number;
  newEntries: number;
  duration_ms: number;
}

const SYSTEM_PROMPT = `You are a memory consolidation processor for a coding agent.
Given a session transcript and existing Layer 1 memory entries, you must:
1. Identify which existing entries are confirmed by the session
2. Identify which entries are contradicted by the session
3. Extract new facts, patterns, or decisions not yet in memory
4. Recommend entries for promotion to Layer 2 (deep memory)

Output ONLY a JSON object with this structure:
{
  "confirmations": ["entry_id_1", ...],
  "contradictions": ["entry_id_2", ...],
  "new_entries": [
    { "kind": "fact|preference|decision|pattern|mistake|constraint", "content": "...", "certainty": "high|medium|low" }
  ],
  "promotions": ["entry_id_3", ...]
}

Rules:
- confirmations: entry IDs that the session reinforces (mentions, uses, or validates)
- contradictions: entry IDs that the session explicitly contradicts or disproves
- new_entries: NEW facts not already covered by existing entries (max 5)
- promotions: entry IDs ready for Layer 2 (high confidence, confirmed multiple times)
- Be conservative: only promote entries with confirmation_count >= threshold AND validity >= 0.6
- Output ONLY the JSON object. No prose.`;

function buildConsolidationPrompt(
  transcript: string,
  layer1Entries: MemoryEntry[],
  promotionThreshold: number,
): string {
  const lines: string[] = [];

  lines.push("## Session Transcript");
  lines.push(truncateText(transcript, 4000));
  lines.push("");

  lines.push("## Existing Layer 1 Entries");
  if (layer1Entries.length === 0) {
    lines.push("(none)");
  } else {
    for (const entry of layer1Entries) {
      lines.push(
        `- [${entry.id}] (${entry.kind}, valid=${entry.validity.toFixed(2)}, useful=${entry.usefulness.toFixed(2)}, confirms=${entry.confirmation_count}) ${entry.content}`
      );
    }
  }
  lines.push("");

  lines.push(`## Promotion Threshold`);
  lines.push(`- confirmation_count >= ${promotionThreshold}`);
  lines.push(`- validity >= 0.6`);
  lines.push("");

  return lines.join("\n");
}

function transcriptToText(events: SessionEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "user_message") lines.push(`User: ${e.content}`);
    else if (e.type === "agent_message") lines.push(`Agent: ${e.content}`);
    else if (e.type === "tool_use") lines.push(`[tool] ${e.tool_name}(${JSON.stringify(e.args ?? {})})`);
    else if (e.type === "tool_result") lines.push(`[result] ${truncateText(JSON.stringify(e.result), 200)}`);
  }
  return lines.join("\n");
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

/**
 * Run the consolidation processor.
 * Re-evaluates session learnings against existing memory and promotes confirmed entries.
 */
export async function runConsolidation(opts: {
  store: MemoryStore;
  llm: SummarizerLLM;
  sessionId: string;
  events: SessionEvent[];
  config: ConsolidationConfig;
}): Promise<ConsolidationResult> {
  const startTime = Date.now();
  const result: ConsolidationResult = {
    promotions: 0,
    confirmations: 0,
    contradictions: 0,
    newEntries: 0,
    duration_ms: 0,
  };

  if (!opts.config.enabled) return result;
  if (opts.events.length === 0) return result;
  if (!(await opts.llm.available())) return result;

  try {
    const now = Date.now();
    // Get only the Layer 1 entries that are actually in play this session.
    const layer1Entries = opts.store.getConsolidationCandidates(now);

    // Build the prompt
    const transcript = transcriptToText(opts.events);
    const prompt = buildConsolidationPrompt(
      transcript,
      layer1Entries,
      opts.config.promotion_threshold,
    );

    // Single LLM call
    const raw = await opts.llm.complete({
      system: SYSTEM_PROMPT,
      prompt,
      temperature: 0.2,
      maxTokens: 2000,
      json: true,
      timeoutMs: 60_000,
    });

    const parsed = JSON.parse(raw) as {
      confirmations?: string[];
      contradictions?: string[];
      new_entries?: Array<{ kind: string; content: string; certainty: string }>;
      promotions?: string[];
    };

    // Process confirmations
    if (Array.isArray(parsed.confirmations)) {
      for (const id of parsed.confirmations) {
        const entry = layer1Entries.find((e) => e.id === id);
        if (entry && entry.layer === 1) {
          opts.store.reinforceFromSuccessfulToolOutcome([id], 0.1);
          result.confirmations++;
        }
      }
    }

    // Process contradictions
    if (Array.isArray(parsed.contradictions)) {
      for (const id of parsed.contradictions) {
        const entry = layer1Entries.find((e) => e.id === id);
        if (entry && entry.layer === 1) {
          // Weaken contradicted entries
          opts.store.weakenEntry(id, 0.2);
          result.contradictions++;
        }
      }
    }

    // Process new entries
    if (Array.isArray(parsed.new_entries)) {
      for (const newEntry of parsed.new_entries.slice(0, 5)) {
        if (["fact", "preference", "decision", "pattern", "mistake", "constraint"].includes(newEntry.kind)) {
          await opts.store.remember(newEntry.content, {
            kind: newEntry.kind as MemoryKind,
            certainty: (newEntry.certainty === "high" || newEntry.certainty === "medium" || newEntry.certainty === "low")
              ? newEntry.certainty
              : "medium",
          });
          result.newEntries++;
        }
      }
    }

    // Process promotions to Layer 2
    if (Array.isArray(parsed.promotions)) {
      for (const id of parsed.promotions) {
        const entry = layer1Entries.find((e) => e.id === id);
        if (
          entry &&
          entry.layer === 1 &&
          entry.confirmation_count >= opts.config.promotion_threshold &&
          effectiveValidity(entry, now) >= 0.6
        ) {
          opts.store.promoteToLayer2(id);
          result.promotions++;
        }
      }
    }
  } catch (err) {
    getAppLogger().child("memory").warn("Error during consolidation", {
      cause: err as Error,
    });
  }

  result.duration_ms = Date.now() - startTime;
  return result;
}
