/**
 * Circuit-breaker loop gate (issue #301).
 *
 * Registered after risk and before write-path acquire.
 */

import type { PostToolCallHandler, PreToolCallHandler } from "../types.js";

export function createCircuitHandlers(): {
  pre: PreToolCallHandler;
  post: PostToolCallHandler;
} {
  return {
    pre: (ctx) => ctx.session.observeCircuitPre?.(ctx.toolName, ctx.args),
    post: (ctx) => {
      ctx.session.observeCircuitPost?.(ctx.toolName, ctx.args, ctx.isError);
    },
  };
}
