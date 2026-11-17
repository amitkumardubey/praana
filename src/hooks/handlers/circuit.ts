/**
 * Circuit-breaker loop gate (issue #578).
 *
 * Registered after risk and before write-path acquire.
 */

import type { PostToolCallHandler, PostTurnHandler, PreToolCallHandler } from "../types.js";

export function createCircuitHandlers(): {
  pre: PreToolCallHandler;
  post: PostToolCallHandler;
  postTurn: PostTurnHandler;
} {
  return {
    pre: (ctx) => ctx.session.observeCircuitPre?.(ctx.toolName, ctx.args),
    post: (ctx) => {
      const gate = ctx.session.loopGate;
      if (!gate) {
        ctx.session.observeCircuitPost?.(ctx.toolName, ctx.args, ctx.isError);
        return;
      }
      if (!gate.observePost(ctx.toolName, ctx.args, ctx.isError, ctx.session.cwd)) return;
      const advisory = "Two or more failed attempts on this target. Re-read the file (or check the command) before retrying.";
      if (typeof ctx.result === "string") return { result: `${ctx.result}\n\n${advisory}` };
      if (ctx.result && typeof ctx.result === "object" && !Array.isArray(ctx.result)) {
        return { result: { ...ctx.result, advisory } };
      }
      // Arrays and primitives keep their shape: no advisory rather than a wrapper.
    },
    postTurn: (ctx) => ctx.session.loopGate?.resetTurn(),
  };
}
