/**
 * Secret redaction for tool results (issue #302).
 *
 * Registered after validate enrich and before write-path release.
 */

import { redactSecrets } from "../../redact/secrets.js";
import type { PostToolCallHandler } from "../types.js";

export function createRedactPostToolCallHandler(): PostToolCallHandler {
  return (ctx) => {
    try {
      return { result: redactSecrets(ctx.result) };
    } catch {
      return;
    }
  };
}
