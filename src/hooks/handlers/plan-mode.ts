import { isPlanModeMutatingTool } from "../../plan-mode.js";
import type { PreToolCallHandler } from "../types.js";

export const PLAN_MODE_BLOCK_ERROR =
  "Plan mode is active. Mutating tools are blocked until the user approves the plan. Use read_file/search_code/find_files/recall/create_task to explore and record the plan, then ask the user to confirm with 'go', 'execute', 'proceed', or 'continue'.";

export function createPlanModePreToolCallHandler(): PreToolCallHandler {
  return (ctx) => {
    if (!ctx.session.isPlanMode()) return;
    if (!isPlanModeMutatingTool(ctx.toolName, ctx.args)) return;
    return {
      action: "block",
      error: PLAN_MODE_BLOCK_ERROR,
      isError: true,
    };
  };
}
