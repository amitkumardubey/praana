import { expect, test } from "bun:test";
import { isChatToolModel } from "../src/provider-catalog.js";
test("recognizes live non-chat model ids", () => {
  for (const id of ["gpt-6.1-terra", "gpt-6-luna", "gemini-3.x-pro"]) expect(isChatToolModel(id)).toBe(true);
  for (const id of ["text-embedding-3-large", "whisper-1", "tts-1", "dall-e-3", "gpt-image-1", "omni-moderation-latest", "gpt-realtime", "sora-2", "davinci-002", "text-embedding-004", "imagen-4", "veo-3", "aqa"]) expect(isChatToolModel(id)).toBe(false);
});
