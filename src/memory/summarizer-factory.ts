// ============================================================
// ARIA Memory — Summarizer factory
// ============================================================

import chalk from "chalk";
import type { MemoryConfig } from "../types.js";
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
  const mode = (config.summarizer ?? "openrouter").toLowerCase();
  if (mode === "disabled") return null;

  if (mode === "ollama") {
    const url = config.ollama_url ?? "http://localhost:11434";
    const configured =
      config.ollama_summarizer_model?.trim() ||
      process.env.ARIA_SUMMARIZER_MODEL?.trim() ||
      "";

    let model = configured;
    if (!model) {
      const names = await listOllamaModelNames(url);
      model = pickDefaultChatModel(names) ?? "";
      if (model) {
        console.log(
          chalk.green(`💾 memory   summarizer model unset — using: ${model}`),
        );
      }
    }

    if (!model) {
      console.warn(
        "[memory] Ollama summarizer enabled but no chat model found.\n" +
          "         Set memory.ollama_summarizer_model or run: ollama pull <model>",
      );
      return null;
    }

    if (!(await OllamaEmbedder.isAvailable(url, model))) {
      console.warn(
        `[memory] Ollama model '${model}' is not available at ${url}.\n` +
          `         Run: ollama pull ${model.split(":")[0]}`,
      );
      return null;
    }

    console.log(chalk.green(`💾 memory   ${model}`));
    return new OllamaSummarizer(url, model);
  }

  if (mode === "openai") {
    const apiKey = process.env.OPENAI_API_KEY ?? "";
    const model =
      process.env.ARIA_SUMMARIZER_MODEL ?? "gpt-4o-mini";
    if (!apiKey) {
      console.warn("[memory] summarizer=openai but OPENAI_API_KEY is not set");
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
      process.env.ARIA_SUMMARIZER_MODEL ?? "google/gemini-2.5-flash";
    if (!apiKey) {
      console.warn(
        "[memory] summarizer=openrouter but OPENROUTER_API_KEY / OPENAI_API_KEY is not set",
      );
      return null;
    }
    return new OpenAISummarizer({ baseUrl, apiKey, model });
  }

  console.warn(
    `[memory] Unknown memory.summarizer '${config.summarizer}' — session-end summarization disabled`,
  );
  return null;
}
