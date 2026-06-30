import type { TranscriptRole } from "./model.js";

/** Whether to insert a Spacer(1) before the next entry. */
export function needsGap(
  role: TranscriptRole,
  prevRole: TranscriptRole | undefined,
): boolean {
  if (!prevRole) return false;
  // Tool rows and consecutive thinking/recall blocks stay tight.
  if (role === "tool" && prevRole === "tool") return false;
  if (role === "thinking" && prevRole === "thinking") return false;
  if (role === "recall" && prevRole === "recall") return false;
  // Everything else gets a blank line above it.
  return true;
}
