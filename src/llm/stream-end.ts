// ============================================================
// PRAANA — How to treat a clean stream close with no final event
// ============================================================

import { getAppLogger } from "../logger.js";
import { isUserDeclaredProvider } from "../provider-registry.js";

export type StreamEndCheck = "auto" | "strict" | "lenient";

/**
 * Provider ids whose protocols always end a successful stream with a final
 * signal. `llm.stream_end_check = "auto"` is strict for these ids and
 * lenient for every other id (other registry providers, local servers, and
 * user-declared `[providers.<id>]` endpoints).
 *
 * - anthropic — Messages API ends with `message_stop` and/or `message_delta.stop_reason`
 * - openai — Chat Completions ends with `finish_reason` and/or `[DONE]`
 * - google — Gemini `streamGenerateContent` ends with `finishReason`
 * - vertex — same Gemini stream as google. Not a PROVIDER_REGISTRY key;
 *   the resolver routes it to GoogleDriver, and the protocol still guarantees
 *   `finishReason`
 * - amazon-bedrock — ConverseStream ends with `messageStop`
 *
 * azure is omitted: it is not a PROVIDER_REGISTRY id (provider-registry.ts
 * only mentions the `azure-openai-responses` API). `auto` is therefore
 * lenient for the `azure` provider id.
 */
export const STREAM_END_STRICT_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "vertex",
  "amazon-bedrock",
]);

let configured: StreamEndCheck = "auto";

export function setStreamEndCheck(next: StreamEndCheck): void {
  configured = next;
}

export function getStreamEndCheck(): StreamEndCheck {
  return configured;
}

/**
 * Resolve whether a clean close that lacks the provider's final signal is an
 * error (`strict`) or a normal finish (`lenient`).
 *
 * Explicit `strict` / `lenient` apply to every provider. `auto` is lenient
 * for user-declared providers even when the id is also in
 * {@link STREAM_END_STRICT_PROVIDERS}, then strict only for that list.
 */
export function resolveStreamEndMode(
  provider: string,
  check: StreamEndCheck = getStreamEndCheck(),
): "strict" | "lenient" {
  if (check === "strict") return "strict";
  if (check === "lenient") return "lenient";
  if (isUserDeclaredProvider(provider)) return "lenient";
  if (STREAM_END_STRICT_PROVIDERS.has(provider)) return "strict";
  return "lenient";
}

/** Debug line so a lenient accept is visible when logging is turned up. */
export function logLenientStreamEnd(provider: string): void {
  getAppLogger()
    .child("llm")
    .debug(`${provider}: stream ended without a final event; accepted (lenient)`);
}
