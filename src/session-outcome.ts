/**
 * Derive a coarse session-success bit from the session-end reason and events.
 * TODO(scorecard): placeholder — replace with real telemetry signal (tests passed,
 * no error-loop, commit landed, etc.) once the scorecard (ADR-005 C1 / #488) exists.
 * Currently: reason is "clean" or "normal" AND at least one non-load_skill tool
 * returned ok = true.
 */

/** One entry of a session transcript, as consumed by session-end bookkeeping. */
export interface SessionEvent {
  type: "user_message" | "agent_message" | "tool_use" | "tool_result";
  timestamp: number;
  content?: string;
  tool_name?: string;
  args?: Record<string, unknown>;
  result?: unknown;
}

/** Session-end outcomes that can count as a success signal. */
export type SessionOutcomeReason = "clean" | "normal" | "aborted" | "error";

export function isSessionGood(
  reason: SessionOutcomeReason,
  events: Array<{ type: string; result?: unknown; tool_name?: string }> | undefined,
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
    // Loading a skill is bookkeeping, not task work — it must not by itself
    // make a session "good" (issue #785).
    if (e.tool_name === "load_skill") return false;
    if (e.result && typeof e.result === "object" && "ok" in e.result) {
      return (e.result as { ok: boolean }).ok === true;
    }
    return false;
  });
}
