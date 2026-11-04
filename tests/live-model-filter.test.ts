import { expect, test } from "bun:test";
import { isChatToolModel } from "../src/provider-catalog.js";
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
