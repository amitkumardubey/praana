// ============================================================
// PRAANA Memory — Public API
// ============================================================

export { MemoryStore } from "./store.js";
export { retractMemory } from "./db.js";
export { OllamaEmbedder, EMBEDDING_DIM } from "./embeddings.js";
export {
  TransformersEmbedder,
  isTransformersAvailable,
  resetTransformersEmbedderForTests,
} from "./transformers-embedder.js";
export { TRANSFORMERS_MODEL_PRESETS } from "./transformers-models.js";
export { createEmbedder, resolveEmbeddingBackend } from "./embedder-factory.js";
export { createSummarizer } from "./summarizer-factory.js";
export { OpenAISummarizer } from "./openai-summarizer.js";
export {
  OllamaSummarizer,
  listOllamaModelNames,
  pickDefaultChatModel,
} from "./ollama-summarizer.js";
export { extractLearnings, summarizeTurns } from "./summarizer.js";
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
