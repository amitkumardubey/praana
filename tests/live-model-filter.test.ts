import { expect, test } from "bun:test";
import { isChatToolModel } from "../src/provider-catalog.js";

const hiddenModels = [
  "text-embedding-3-large", "text-embedding-ada-002", "gemini-embedding-001",
  "bge-embedder", "nomic-embed-text", "whisper-1", "tts-1", "tts-1-hd",
  "gpt-4o-mini-tts", "gpt-4o-mini-transcribe", "gpt-4o-transcribe",
  "gpt-4o-realtime-preview", "gpt-realtime", "gpt-4o-audio-preview",
  "gpt-4o-mini-audio-preview", "qwen2-audio", "gemini-2.5-flash-preview-tts",
  "gemini-2.0-flash-live-001", "dall-e-3", "gpt-image-1",
  "imagen-4.0-generate-001", "veo-3.0-generate-preview", "sora-2",
  "omni-moderation-latest", "text-moderation-latest", "davinci-002",
  "babbage-002", "gpt-3.5-turbo-instruct", "aqa",
  "gemini-2.0-flash-preview-image-generation", "mxbai-embed-large",
  "voyage-3-embedding", "models/gemini-embedding-001", "cohere-embed-english-v3.0",
];

const visibleModels = [
  "meta-llama/Llama-3.3-70B-Instruct", "Qwen/Qwen2.5-Coder-32B-Instruct-Turbo",
  "mistral-7b-instruct", "granite-3-instruct", "command-r-plus", "gpt-4o",
  "gpt-4o-mini", "gpt-6.1-terra", "gpt-6-luna", "o3-mini", "claude-opus-5-5",
  "claude-3-5-sonnet-20241022", "gemini-2.5-pro", "gemini-2.0-flash",
  "deepseek-chat", "deepseek-r1-distill-llama-70b", "llama3.1:8b", "qwen3-coder",
  "codestral-latest", "mistral-large-latest", "grok-4", "kimi-k2-instruct",
  "glm-5.3", "nvidia/llama-3.1-nemotron-70b-instruct", "openai/gpt-oss-120b",
  "phi-4", "gemma-3-27b-it", "anthropic/claude-sonnet-5-5", "livecodebench-llama",
  "olive-7b", "deliver-chat-1", "gpt-4.1", "llama-guard-4",
];

test.each(hiddenModels)("hides non-chat model %s", (id) => {
  expect(isChatToolModel(id)).toBe(false);
});

test.each(visibleModels)("keeps chat model %s visible", (id) => {
  expect(isChatToolModel(id)).toBe(true);
});
test("recognizes live non-chat model ids", () => {
  for (const id of [
    "gpt-6.1-terra", "gpt-6-luna", "gemini-3.x-pro", "claude-3-5-sonnet-20241022",
    "meta-llama/Llama-3.3-70B-Instruct", "Qwen2.5-Coder-32B-Instruct", "mistral-7b-instruct",
    "granite-3-instruct", "command-r-plus", "accounts/fireworks/models/llama-v3p3-70b-instruct",
    "mistralai/mistral-large-2411", "nvidia/llama-3.1-nemotron-70b-instruct", "llama3.3:70b",
  ]) expect(isChatToolModel(id)).toBe(true);
  for (const id of ["gpt-3.5-turbo-instruct", "qwen2-audio", "gpt-4o-audio-preview", "nomic-embed-text", "gemini-embedding-001"]) expect(isChatToolModel(id)).toBe(false);
  for (const id of ["text-embedding-3-large", "whisper-1", "tts-1", "dall-e-3", "gpt-image-1", "omni-moderation-latest", "gpt-realtime", "sora-2", "davinci-002", "text-embedding-004", "imagen-4", "veo-3", "aqa"]) expect(isChatToolModel(id)).toBe(false);
});
