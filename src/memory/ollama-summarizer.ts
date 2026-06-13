// ============================================================
// PRAANA Memory — Ollama Summarizer Adapter
// ============================================================

import { OllamaEmbedder } from "./embeddings.js";
import type { SummarizerLLM } from "./types.js";

export async function listOllamaModelNames(url: string): Promise<string[]> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { models: { name: string }[] };
    return data.models.map((m) => m.name);
  } catch {
    return [];
  }
}

/** First installed model that does not look like an embedding model. */
export function pickDefaultChatModel(names: string[]): string | null {
  const chat = names.filter((n) => !/embed/i.test(n));
  return chat[0] ?? null;
}

export class OllamaSummarizer implements SummarizerLLM {
  readonly name: string;

  constructor(
    private url: string,
    private model: string,
  ) {
    this.url = url.replace(/\/$/, "");
    this.name = `ollama:${model}`;
  }

  async available(): Promise<boolean> {
    return OllamaEmbedder.isAvailable(this.url, this.model);
  }

  async complete(opts: {
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
    timeoutMs?: number;
  }): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? 60_000,
    );
    try {
      const messages: { role: string; content: string }[] = [];
      if (opts.system) messages.push({ role: "system", content: opts.system });
      messages.push({ role: "user", content: opts.prompt });

      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        stream: false,
        options: {
          temperature: opts.temperature ?? 0.3,
          num_predict: opts.maxTokens ?? 1500,
        },
      };
      if (opts.json) body.format = "json";

      const res = await fetch(`${this.url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Summarizer ${res.status}: ${await res.text()}`);
      }

      const json = (await res.json()) as { message?: { content?: string } };
      return json.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }
}
