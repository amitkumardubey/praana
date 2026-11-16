/**
 * Derive a coarse session-success bit from the session-end reason and events.
 * TODO(scorecard): placeholder — replace with real telemetry signal (tests passed,
 * no error-loop, commit landed, etc.) once the scorecard (ADR-005 C1 / #488) exists.
 * Currently: reason is "clean" or "normal" AND at least one tool returned ok = true.
 */
export function isSessionGood(
  reason: string,
  events: Array<{ type: string; result?: unknown }> | undefined,
): boolean {
  if (reason !== "clean" && reason !== "normal") return false;
  if (!events || events.length === 0) return true; // no events → assume good
  // NOTE: sessions with only user/agent messages (no tool calls) return false here,
  // meaning used entries get neutral rather than boosted usefulness. This is intentional
  // for the placeholder — a tool-free session gives no signal about memory utility.
  // TODO(scorecard): replace with real telemetry once ADR-005 C1 / #488 delivers a
  // reliable success signal that covers conversational sessions too.
  return events.some((e) => {
    if (e.type !== "tool_result") return false;
    if (e.result && typeof e.result === "object" && "ok" in e.result) {
      return (e.result as { ok: boolean }).ok === true;
    }
    return false;
  });
}
