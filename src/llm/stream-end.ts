// ============================================================
// PRAANA — How to treat a clean stream close with no final event
// ============================================================

import { getAppLogger } from "../logger.js";
import { isUserDeclaredProvider, PROVIDER_REGISTRY } from "../provider-registry.js";
import type { StreamEvent } from "./types.js";

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

/** Hostname of an absolute or scheme-relative base URL, or null when it is unset. */
export function endpointHostname(url: string | undefined): string | null {
  if (!url || !url.trim()) return null;
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
    return new URL(withScheme).hostname.replace(/\.$/, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * True when this request should use the hosted connect budget and, under
 * `auto`, the strict end check.
 *
 * Hosted means the id is in {@link STREAM_END_STRICT_PROVIDERS}, it is not a
 * user-declared `[providers.<id>]` entry, and the effective base URL is unset
 * or its host is that provider's built-in registry host. Any other host,
 * including loopback and private addresses, is not hosted.
 */
export function isDefaultHostedEndpoint(provider: string, baseUrl?: string): boolean {
  if (isUserDeclaredProvider(provider)) return false;
  if (!STREAM_END_STRICT_PROVIDERS.has(provider)) return false;
  const given = endpointHostname(baseUrl);
  if (!given) return true;
  const builtin = endpointHostname(PROVIDER_REGISTRY[provider]?.baseUrl);
  if (!builtin) return false;
  return given === builtin;
}

/**
 * Resolve whether a clean close that lacks the provider's final signal is an
 * error (`strict`) or a normal finish (`lenient`).
 *
 * Explicit `strict` / `lenient` apply to every provider. `auto` is strict only
 * for {@link isDefaultHostedEndpoint}. An omitted check is `auto`.
 */
export function resolveStreamEndMode(
  provider: string,
  check: StreamEndCheck = "auto",
  baseUrl?: string,
): "strict" | "lenient" {
  if (check === "strict") return "strict";
  if (check === "lenient") return "lenient";
  return isDefaultHostedEndpoint(provider, baseUrl) ? "strict" : "lenient";
}

/** Error event for a clean close that never delivered the provider's final signal. */
export function prematureEndError(
  signal: string,
  retryable: boolean,
): Extract<StreamEvent, { type: "error" }> {
  return {
    type: "error",
    error: new Error(`stream ended before the provider sent a final event (${signal})`),
    retryable,
    kind: "premature_end",
  };
}

/** Debug line so a lenient accept is visible when logging is turned up. */
export function logLenientStreamEnd(provider: string): void {
  getAppLogger()
    .child("llm")
    .debug(`${provider}: stream ended without a final event; accepted (lenient)`);
}
