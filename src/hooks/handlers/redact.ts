/**
 * Secret redaction for tool results (issue #579).
 *
 * Registered after validate enrich and before write-path release.
 */

import { getAppLogger } from "../../logger.js";
import { redactionFailureFor, redactSecrets } from "../../redact/secrets.js";
import type { PostToolCallHandler } from "../types.js";

/**
 * A failure here must not pass the raw result on: the registry applies any patch
 * that has a `result` key, so the catch returns the redaction-error placeholder.
 * `redact` is injectable so a test can force that path.
 */
export function createRedactPostToolCallHandler(
  redact: (value: unknown) => unknown = redactSecrets,
): PostToolCallHandler {
  return (ctx) => {
    let result: unknown;
    try {
      result = ctx.result;
      return { result: redact(result) };
    } catch (error) {
      const placeholder = redactionFailureFor(result);
      try {
        getAppLogger().child("tool").debug("Redact hook failed; result replaced", {
          // Name only: a hostile error message could carry the value.
          details: { error: error instanceof Error ? error.name : "non-error" },
        });
      } catch {
        // Logging must not prevent the fail-closed patch.
      }
      return { result: placeholder };
    }
  };
}
