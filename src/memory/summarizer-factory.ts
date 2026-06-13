// ============================================================
// ARIA Memory — Summarizer factory
// ============================================================

import type { MemoryConfig } from "../types.js";
import { getAppLogger } from "../logger.js";
import { envOverride } from "../app-identity.js";
import { OllamaEmbedder } from "./embeddings.js";
import {
  OllamaSummarizer,
  listOllamaModelNames,
  pickDefaultChatModel,
} from "./ollama-summarizer.js";
import { OpenAISummarizer } from "./openai-summarizer.js";
import type { SummarizerLLM } from "./types.js";

export async function createSummarizer(
  config: MemoryConfig,
): Promise<SummarizerLLM | null> {
  const log = getAppLogger().child("memory");
  const mode = (config.summarizer ?? "openrouter").toLowerCase();
  if (mode === "disabled") return null;

  if (mode === "ollama") {
    const url = config.ollama_url ?? "http://localhost:11434";
    const configured =
      config.ollama_summarizer_model?.trim() ||
      envOverride("PRAANA_SUMMARIZER_MODEL", "ARIA_SUMMARIZER_MODEL")?.trim() ||
      "";

    let model = configured;
    if (!model) {
      const names = await listOllamaModelNames(url);
      model = pickDefaultChatModel(names) ?? "";
      if (model) {
        log.notice(`summarizer model unset — using: ${model}`);
      }
    }

    if (!model) {
      log.warn(
        "Ollama summarizer enabled but no chat model found. Set memory.ollama_summarizer_model or run: ollama pull <model>",
      );
      return null;
    }

    if (!(await OllamaEmbedder.isAvailable(url, model))) {
      log.warn(
        `Ollama model '${model}' is not available at ${url}. Run: ollama pull ${model.split(":")[0]}`,
      );
      return null;
    }

    log.notice(`summarizer: ${model}`);
    return new OllamaSummarizer(url, model);
  }

  if (mode === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    const model =
      envOverride("PRAANA_SUMMARIZER_MODEL", "ARIA_SUMMARIZER_MODEL") ?? "gpt-4o-mini";
    if (!apiKey) {
      log.warn("summarizer=openai but OPENAI_API_KEY is not set");
      return null;
    }
    return new OpenAISummarizer({
      baseUrl: "https://api.openai.com/v1",
      apiKey,
      model,
    });
  }

  // openrouter (default) and legacy "openrouter" spelling
  if (mode === "openrouter" || mode === "openai-compatible") {
    const openRouterKey = process.env.OPENROUTER_API_KEY ?? "";
    const openAiKey = process.env.OPENAI_API_KEY ?? "";
    const apiKey = openRouterKey || openAiKey;
    const baseUrl = openRouterKey
      ? "https://openrouter.ai/api/v1"
      : "https://api.openai.com/v1";
    const model =
      envOverride("PRAANA_SUMMARIZER_MODEL", "ARIA_SUMMARIZER_MODEL") ??
      "google/gemini-2.5-flash";
    if (!apiKey) {
      log.warn("summarizer=openrouter but OPENROUTER_API_KEY / OPENAI_API_KEY is not set");
      return null;
    }
    return new OpenAISummarizer({ baseUrl, apiKey, model });
  }

  log.warn(`Unknown memory.summarizer '${config.summarizer}' — session-end summarization disabled`);
  return null;
}
