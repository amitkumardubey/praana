// ============================================================
// ARIA Memory — Public API
// ============================================================

export { MemoryStore } from "./store.js";
export { HashEmbedder, EMBEDDING_DIM } from "./embeddings.js";
export { OpenAISummarizer } from "./openai-summarizer.js";
export { extractLearnings } from "./summarizer.js";
export type {
  MemoryEntry,
  MemoryKind,
  Certainty,
  SessionContext,
  SessionEvent,
  Digest,
  RecallOptions,
  RecallResult,
  RememberOptions,
  ExtractedLearning,
  SummarizerLLM,
  Embedder,
} from "./types.js";
