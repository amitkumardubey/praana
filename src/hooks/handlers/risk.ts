/**
 * Risk-tiered action gating (issue #580).
 *
 * Registered after validate and before write-path acquire.
 */

import { classifyRisk } from "../../risk/classify.js";
import type { RiskConfirmResult } from "../../risk/classes.js";
import { formatWebFetchPrompt } from "../../risk/prompt.js";
import { hostnameOf } from "../../tools/web/policy.js";
import type { PreToolCallHandler } from "../types.js";

function fetchHost(args: Record<string, unknown>): string {
  return typeof args.url === "string" ? hostnameOf(args.url) ?? "" : "";
}

export function createRiskPreToolCallHandler(cwd: string): PreToolCallHandler {
  return async (ctx) => {
    const hit = classifyRisk(ctx.toolName, ctx.args, cwd);
    if (!hit) return;
    if (hit.class === "web_fetch_host") {
      const host = fetchHost(ctx.args);
      const policy = ctx.session.webFetchPolicy?.(host) ?? "confirm";
      if (policy === "disabled") {
        return { action: "block", error: "web_fetch is disabled", isError: true };
      }
      if (policy === "deny") {
        return {
          action: "block",
          error: `Blocked by tools.web domain rules (${host})`,
          isError: true,
        };
      }
      if (policy === "allow" || ctx.session.webFetchHostRemembered?.(host)) return;
    }
    const prompt =
      hit.class === "web_fetch_host" ? formatWebFetchPrompt(hit.detail) : `${hit.class}: ${hit.detail}`;
    let result: RiskConfirmResult;
    if (!ctx.session.confirmRisk) {
      result = { allowed: false, reason: "headless" };
    } else {
      try {
        // Share one prompt per host: concurrent fetches to the same new host
        // would otherwise each pass the "not remembered" check above.
        result =
          hit.class === "web_fetch_host" && ctx.session.confirmWebFetchHost
            ? await ctx.session.confirmWebFetchHost(fetchHost(ctx.args), prompt)
            : await ctx.session.confirmRisk(hit.class, prompt);
      } catch {
        result = { allowed: false, reason: "declined" };
      }
    }
    if (result.allowed) {
      if (hit.class === "web_fetch_host") {
        const host = fetchHost(ctx.args);
        if (host) ctx.session.rememberWebFetchHost?.(host);
      }
      return;
    }
    let error: string;
    if (result.reason === "headless") {
      error =
        hit.class === "web_fetch_host"
          ? "Blocked in headless (web_fetch_host). Add the host to [tools.web].allow_domains or add web_fetch_host to [risk].allow."
          : `Blocked in headless (${hit.class}). Add it to [risk].allow to permit.`;
    } else {
      error = `User declined ${hit.class}: ${hit.detail}`;
    }
    return { action: "block", error, isError: true };
  };
}
