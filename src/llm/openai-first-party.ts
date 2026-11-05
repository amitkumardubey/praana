import { OpenAICompatibleDriver } from "./drivers/openai.js";
import { OpenAIResponsesDriver } from "./drivers/responses.js";
import { ProviderHttpError } from "./stream-guard.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "./types.js";
import { getAppLogger } from "../logger.js";

const responses = new OpenAIResponsesDriver();
const chat = new OpenAICompatibleDriver();
const chatOnlyModels = new Set<string>();

function unsupportedResponsesModel(error: Error): boolean {
  // SDK types verify the {error:{code,message}} envelope, not the exact
  // endpoint-rejection wording. Until verified live, use only the conservative
  // 404 + model_not_found / model-not-supported heuristic, never arbitrary 400s
  // or SSE errors. ProviderHttpError is only constructed before body streaming.
  if (!(error instanceof ProviderHttpError) || error.status !== 404) return false;
  let code: unknown;
  let message = error.body;
  try {
    const parsed = JSON.parse(error.body) as { error?: { code?: unknown; message?: unknown } };
    code = parsed?.error?.code;
    if (typeof parsed?.error?.message === "string") message = parsed.error.message;
  } catch { /* Plain-text errors may still describe an unsupported model. */ }
  return code === "model_not_found" ||
    /\bmodel\b[\s\S]*\bnot supported\b|\bnot supported\b[\s\S]*\bmodel\b/i.test(message);
}

/** Called only after the conservative first-party routing checks. */
export async function* streamFirstPartyOpenAI(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent> {
  if (chatOnlyModels.has(req.model)) {
    yield* chat.stream({ ...req, api: "openai-completions" }, auth);
    return;
  }
  let emitted = false;
  for await (const event of responses.stream(req, auth)) {
    if (!emitted && !req.signal?.aborted && event.type === "error" && unsupportedResponsesModel(event.error)) {
      chatOnlyModels.add(req.model);
      getAppLogger().child("llm").warn("OpenAI Responses rejected the model; using Chat Completions for this process", {
        details: { model: req.model },
      });
      yield* chat.stream({ ...req, api: "openai-completions" }, auth);
      return;
    }
    emitted = true; // Includes usage, thinking, tool starts, errors, and done.
    yield event;
  }
}
