/**
 * Risk-tiered action gating (issue #303).
 *
 * Registered after validate and before write-path acquire.
 */

import { classifyRisk } from "../../risk/classify.js";
import type { RiskConfirmResult } from "../../risk/classes.js";
import type { PreToolCallHandler } from "../types.js";

export function createRiskPreToolCallHandler(cwd: string): PreToolCallHandler {
  return async (ctx) => {
    const hit = classifyRisk(ctx.toolName, ctx.args, cwd);
    if (!hit) return;
    const prompt = `${hit.class}: ${hit.detail}`;
    let result: RiskConfirmResult;
    if (!ctx.session.confirmRisk) {
      result = { allowed: false, reason: "headless" };
    } else {
      try {
        result = await ctx.session.confirmRisk(hit.class, prompt);
      } catch {
        result = { allowed: false, reason: "declined" };
      }
    }
    if (result.allowed) return;
    const error =
      result.reason === "headless"
        ? `Blocked in headless (${hit.class}). Add it to [risk].allow to permit.`
        : `User declined ${hit.class}: ${hit.detail}`;
    return { action: "block", error, isError: true };
  };
}
