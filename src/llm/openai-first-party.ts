import { createHash } from "node:crypto";
import { OpenAICompatibleDriver } from "./drivers/openai.js";
import { OpenAIResponsesDriver } from "./drivers/responses.js";
import { ProviderHttpError } from "./stream-guard.js";
import type { ResolvedAuth, StreamEvent, StreamRequest } from "./types.js";
import { getAppLogger } from "../logger.js";

const responses = new OpenAIResponsesDriver();
const chat = new OpenAICompatibleDriver();

interface ChatOnlyEntry {
  /** SHA-256 of the credential used when the model was pinned. */
  fingerprint: string;
  expiresAt: number;
}

/** Remember a model as Chat-only only for the credential that hit the 404. */
const chatOnlyModels = new Map<string, ChatOnlyEntry>();
const CHAT_ONLY_TTL_MS = 60 * 60 * 1000; // 1 hour
let chatOnlyClock: () => number = Date.now;

/** Test hook: replace the clock used for Chat-only fallback expiry. */
export function setChatOnlyFallbackClockForTests(clock: () => number): void {
  chatOnlyClock = clock;
}

/** Test hook: clear the remembered set and restore the real clock. */
export function resetChatOnlyFallbackForTests(): void {
  chatOnlyModels.clear();
  chatOnlyClock = Date.now;
}

function credentialFingerprint(auth: ResolvedAuth): string {
  const material = auth.apiKey ?? auth.bearerToken ?? "";
  return createHash("sha256").update(material).digest("hex");
}

function isRememberedChatOnly(model: string, auth: ResolvedAuth): boolean {
  const entry = chatOnlyModels.get(model);
  if (!entry) return false;
  // Entries are scoped to the credential that proved the rejection and expire
  // after one hour, so a key change or a transient misroute self-heals.
  if (entry.fingerprint !== credentialFingerprint(auth) || entry.expiresAt <= chatOnlyClock()) {
    chatOnlyModels.delete(model);
    return false;
  }
  return true;
}

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
  if (isRememberedChatOnly(req.model, auth)) {
    yield* chat.stream({ ...req, api: "openai-completions" }, auth);
    return;
  }
  let emitted = false;
  for await (const event of responses.stream(req, auth)) {
    if (!emitted && !req.signal?.aborted && event.type === "error" && unsupportedResponsesModel(event.error)) {
      chatOnlyModels.set(req.model, {
        fingerprint: credentialFingerprint(auth),
        expiresAt: chatOnlyClock() + CHAT_ONLY_TTL_MS,
      });
      getAppLogger().child("llm").warn("OpenAI Responses rejected the model; using Chat Completions for this credential", {
        details: { model: req.model },
      });
      yield* chat.stream({ ...req, api: "openai-completions" }, auth);
      return;
    }
    emitted = true; // Includes usage, thinking, tool starts, errors, and done.
    yield event;
  }
}
