/**
 * Canonical reasoning effort levels and parser shared by LLM routing and settings persistence.
 */

export const REASONING_EFFORT_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

export function parseReasoningEffort(raw: string): ReasoningEffortLevel | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "none") return "off";
  if ((REASONING_EFFORT_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as ReasoningEffortLevel;
  }
  return null;
}
