// ============================================================
// ARIA Memory — Core Types
//
// A simplified, purpose-built cross-session memory layer.
// Replaces bodha dependency with ~600 lines of focused code.
// ============================================================

export const MEMORY_KINDS = [
  "fact",
  "preference",
  "decision",
  "pattern",
  "mistake",
  "constraint",
] as const;

export type MemoryKind =
  | "fact"        // verifiable: "project uses Vitest"
  | "preference"  // user/agent preference: "prefers dark mode"
  | "decision"    // explicit choice: "use jwt over sessions"
  | "pattern"     // recurring approach: "use zod for validation"
  | "mistake"     // failure + lesson: "forgot to await promise → 401s"
  | "constraint"; // must-follow: "never commit .env files"

export function isMemoryKind(value: string): value is MemoryKind {
  return MEMORY_KINDS.includes(value as MemoryKind);
}

export type Certainty = "high" | "medium" | "low";

export type MemoryLayer = 1 | 2;

export interface MemoryEntry {
  id: string;              // ULID
  kind: MemoryKind;
  content: string;
  confidence: number;      // 0.0–1.0, starts at creation value
  pinned: boolean;         // never forget, always in digest
  layer: MemoryLayer;      // 1 = working, 2 = consolidated/deep
  confirmation_count: number; // sessions that confirmed this entry
  created_at: number;      // unix ms
  last_seen_at: number;    // unix ms, updated on recall touch
  session_id: string;      // which session created it
  scopes: string[];        // explicit scope labels, e.g. ["context:proj-a"]
  embedding?: Buffer;      // 384-dim float32 buffer
}

export interface SessionContext {
  agent: string;
  user_id: string;
  time: number;
  context_id: string;
  context_label: string;
  working_context?: Record<string, unknown>;
}

export interface Digest {
  markdown: string;
  empty: boolean;
  entriesIncluded: string[];
}

export interface RecallOptions {
  limit?: number;
  scope?: string[];
  mode?: "standard" | "causal_chain";
  kinds?: MemoryKind[];
}

export interface RecallResult {
  entries: Array<{
    id: string;
    kind: MemoryKind;
    content: string;
    confidence: number;
    match: number;         // query-match score (higher means more relevant)
    scopes: string[];
    score: number;         // final ranking score (currently equals match)
  }>;
}

export interface RememberOptions {
  kind?: MemoryKind;
  certainty?: Certainty;
  pinned?: boolean;
  scope?: string[];        // explicit isolation, e.g. ["context:proj-a"]
}

// Summarizer

export interface Embedder {
  dim: number;
  embed(text: string): Promise<Float32Array>;
}

export interface SummarizerLLM {
  name: string;
  available(): Promise<boolean>;
  complete(opts: {
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
    timeoutMs?: number;
  }): Promise<string>;
}

export interface SessionEvent {
  type: "user_message" | "agent_message" | "tool_use" | "tool_result";
  timestamp: number;
  content?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

export interface ExtractedLearning {
  kind: MemoryKind;
  content: string;
  certainty: Certainty;
  scope_hints?: string[];
}
