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
   * Validate API key / credentials against the provider endpoint.
   */
  validateKey?(auth: ResolvedAuth, model?: string): Promise<boolean>;
}
