import type { TranscriptRole } from "./model.js";

/** Whether to insert a Spacer(1) before the next entry. */
export function needsGap(
  role: TranscriptRole,
  prevRole: TranscriptRole | undefined,
): boolean {
  if (!prevRole) return false;
  if (role === "user") return true;
  if (role === "turn_footer") return false;
  if (role === "tool") return prevRole !== "tool";
  if (role === "thinking" && prevRole !== "thinking") return true;
  if (role === "recall") return prevRole !== "recall";
  if (
    role === "assistant" &&
    (prevRole === "tool" ||
      prevRole === "thinking" ||
      prevRole === "user" ||
      prevRole === "recall")
  ) {
    return true;
  }
  return false;
}
