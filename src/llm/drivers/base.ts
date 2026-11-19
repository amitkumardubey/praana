// ============================================================
// PRAANA — Base Protocol Driver Interface
// ============================================================

import type { StreamRequest, StreamEvent, ResolvedAuth } from "../types.js";

/**
 * Common Strategy interface implemented by all wire protocol drivers.
 */
export interface LlmDriver {
  readonly protocol: string;

  /**
   * Stream LLM response chunks as pure StreamEvent objects.
   */
  stream(req: StreamRequest, auth: ResolvedAuth): AsyncIterable<StreamEvent>;

  /**
   * Output token cap this driver puts on the wire for the first attempt of
   * `req`, or null when it sends no cap. Read-only: it mirrors the request
   * builder and must be kept in step with it.
   */
  effectiveMaxTokens(req: StreamRequest): number | null;

  /**
   * Largest output token cap any attempt of `req` can send, including retries
   * that change the request form. Equal to `effectiveMaxTokens` unless the
   * driver rewrites the cap on retry. Null when no attempt sends a cap.
   */
  effectiveMaxTokensUpperBound(req: StreamRequest): number | null;

  /**
   * Validate API key / credentials against the provider endpoint.
   */
  validateKey?(auth: ResolvedAuth, model?: string): Promise<boolean>;
}
