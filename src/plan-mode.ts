/**
 * Plan-mode helpers and constants.
 *
 * Centralises the logic for detecting when the user wants to enter/exit plan
 * mode and for deciding whether a tool call is mutating while plan mode is
 * active. Keeping this in one module lets the pre_tool_call hook handler and
 * the system-frame prompt (compiler.ts) stay in sync.
 */

export const PLAN_MODE_BLOCKED_TOOLS = new Set([
  "edit_file",
  "write_file",
  "batch_edit",
  "batch_write",
]);

const PLAN_APPROVAL_WORDS = new Set(["go", "execute", "proceed", "continue"]);

const PLAN_APPROVAL_DEFERRAL_WORDS = new Set([
  "back",
  "to",
  "reading",
  "read",
  "search",
  "searching",
  "research",
  "researching",
  "explore",
  "exploring",
  "review",
  "reviewing",
  "check",
  "checking",
  "look",
  "looking",
  "carefully",
  "caution",
  "later",
  "soon",
  "tomorrow",
  "first",
  "before",
  "planning",
]);

/**
 * Detect whether the user's message is an approval to leave plan mode.
 *
 * The detection is intentionally conservative: approval words are ignored when
 * followed by deferral words that indicate the user is still exploring or wants
 * to delay execution (e.g. "continue reading", "execute a search").
 */
export function detectPlanApproval(userInput: string): boolean {
  const words = userInput.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w, i) => {
    if (!PLAN_APPROVAL_WORDS.has(w)) return false;
    const next = words[i + 1];
    const afterNext = words[i + 2];
    if (next && PLAN_APPROVAL_DEFERRAL_WORDS.has(next)) return false;
    if (afterNext && PLAN_APPROVAL_DEFERRAL_WORDS.has(afterNext)) return false;
    return true;
  });
}

/**
 * Detect whether the user's message indicates they want to enter plan mode.
 *
 * Triggers on pick-an-issue phrasing or explicit planning-of-work phrasing.
 * Avoids triggering on general discussion of execution (e.g. "plan the
 * execution" should not arm the gate).
 */
export function detectPlanModeIntent(userInput: string): boolean {
  const lower = userInput.toLowerCase();
  const pickIssue = /\bpick\b/.test(lower) && /\b(issue|ticket)\b/.test(lower);
  const planWork =
    /\bplan\b/.test(lower) && /\b(branch|implement|work on)\b/.test(lower);
  return pickIssue || planWork;
}

/**
 * Return true for shell commands that create a new git branch.
 *
 * Covers `git checkout -b`, `git switch -c`, `git branch <name>`, and
 * `git branch -c/-C`. Listing, deleting, renaming, or plain checkout/switch are
 * not treated as creation.
 */
export function isBranchCreatingShellCommand(command: string): boolean {
  const c = command.trim().toLowerCase();
  if (/\bgit\s+checkout\s+-[bB]\b/.test(c)) return true;
  if (/\bgit\s+switch\s+-[cC]\b/.test(c)) return true;
  if (/\bgit\s+branch\s+-[cC]\b/.test(c)) return true;
  const branchMatch = c.match(/\bgit\s+branch\s+(\S+)/);
  if (branchMatch) return !branchMatch[1].startsWith("-");
  return false;
}

/** Decide whether a tool call is mutating while plan mode is active. */
export function isPlanModeMutatingTool(
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (PLAN_MODE_BLOCKED_TOOLS.has(toolName)) return true;
  if (toolName === "shell" && typeof args.command === "string") {
    return isBranchCreatingShellCommand(args.command);
  }
  return false;
}
