// ============================================================
// PRAANA Memory — OpenAI/OpenRouter Summarizer Adapter
// ============================================================

import type { SummarizerLLM } from "./types.js";

export class OpenAISummarizer implements SummarizerLLM {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts: { baseUrl: string; apiKey: string; model: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.name = `openai:${opts.model}`;
  }

  async available(): Promise<boolean> {
    return this.apiKey.length > 0;
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
      opts.timeoutMs ?? 60_000
    );
    try {
      const messages: { role: string; content: string }[] = [];
      if (opts.system) messages.push({ role: "system", content: opts.system });
      messages.push({ role: "user", content: opts.prompt });

      const body: Record<string, unknown> = { model: this.model, messages };
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
      if (opts.json) body.response_format = { type: "json_object" };

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Summarizer ${res.status}: ${await res.text()}`);

      const json = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      return json.choices[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timeout);
    }
  }
}
