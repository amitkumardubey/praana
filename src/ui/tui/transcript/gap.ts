import type { TranscriptRole } from "./model.js";

/** Whether to insert a Spacer(1) before the next entry. */
export function needsGap(
  role: TranscriptRole,
  prevRole: TranscriptRole | undefined,
): boolean {
  if (!prevRole) return false;
  // Consecutive thinking/recall blocks stay tight; tool rows get a blank line between them.
  if (role === "thinking" && prevRole === "thinking") return false;
  if (role === "recall" && prevRole === "recall") return false;
  // Everything else gets a blank line above it.
  return true;
}
