import type {
  HookLogger,
  HookSessionLike,
  PostToolCallContext,
  PostToolCallDispatchResult,
  PostToolCallHandler,
  PostTurnContext,
  PostTurnHandler,
  PreCompileContext,
  PreCompileHandler,
  PreToolCallContext,
  PreToolCallDispatchResult,
  PreToolCallHandler,
  SessionLifecycleContext,
  SessionLifecycleHandler,
} from "./types.js";

function logHookError(
  session: HookSessionLike,
  hookPoint: string,
  err: unknown,
): void {
  const logger = session.getLogger?.() as HookLogger | undefined;
  if (!logger?.child) return;
  const cause = err instanceof Error ? err : undefined;
  logger.child("tool").warn(`Hook ${hookPoint} failed`, {
    cause,
    details: {
      hook: hookPoint,
      error: err instanceof Error ? err.message : String(err),
    },
  });
}

/**
 * Ordered internal hook dispatcher. Handlers run in registration order.
 * Sync returns and Promises are both supported.
 */
export class HookRegistry {
  private readonly preToolCall: PreToolCallHandler[] = [];
  private readonly postToolCall: PostToolCallHandler[] = [];
  private readonly preCompile: PreCompileHandler[] = [];
  private readonly postTurn: PostTurnHandler[] = [];
  private readonly sessionStart: SessionLifecycleHandler[] = [];
  private readonly sessionEnd: SessionLifecycleHandler[] = [];

  onPreToolCall(handler: PreToolCallHandler): void {
    this.preToolCall.push(handler);
  }

  onPostToolCall(handler: PostToolCallHandler): void {
    this.postToolCall.push(handler);
  }

  onPreCompile(handler: PreCompileHandler): void {
    this.preCompile.push(handler);
  }

  onPostTurn(handler: PostTurnHandler): void {
    this.postTurn.push(handler);
  }

  onSessionStart(handler: SessionLifecycleHandler): void {
    this.sessionStart.push(handler);
  }

  onSessionEnd(handler: SessionLifecycleHandler): void {
    this.sessionEnd.push(handler);
  }

  async runPreToolCall(ctx: PreToolCallContext): Promise<PreToolCallDispatchResult> {
    let args = { ...ctx.args };
    for (const handler of this.preToolCall) {
      try {
        const result = await handler({ ...ctx, args });
        if (result && result.action === "block") {
          return {
            action: "block",
            error: result.error,
            isError: result.isError ?? true,
            ...(result.suggestions?.length
              ? { suggestions: result.suggestions }
              : {}),
          };
        }
        if (result?.args) {
          args = result.args;
        }
      } catch (err) {
        return {
          action: "block",
          error: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    }
    return { action: "continue", args };
  }

  async runPostToolCall(
    ctx: PostToolCallContext,
  ): Promise<PostToolCallDispatchResult> {
    let result = ctx.result;
    let isError = ctx.isError;
    for (const handler of this.postToolCall) {
      try {
        const patch = await handler({ ...ctx, result, isError });
        if (patch?.result !== undefined) result = patch.result;
        if (typeof patch?.isError === "boolean") isError = patch.isError;
      } catch (err) {
        logHookError(ctx.session, "post_tool_call", err);
      }
    }
    return { result, isError };
  }

  async runPreCompile(ctx: PreCompileContext): Promise<void> {
    for (const handler of this.preCompile) {
      try {
        await handler(ctx);
      } catch (err) {
        logHookError(ctx.session, "pre_compile", err);
      }
    }
  }

  async runPostTurn(ctx: PostTurnContext): Promise<void> {
    for (const handler of this.postTurn) {
      try {
        await handler(ctx);
      } catch (err) {
        logHookError(ctx.session, "post_turn", err);
      }
    }
  }

  async runSessionStart(ctx: SessionLifecycleContext): Promise<void> {
    for (const handler of this.sessionStart) {
      try {
        await handler(ctx);
      } catch (err) {
        logHookError(ctx.session, "session_start", err);
      }
    }
  }

  async runSessionEnd(ctx: SessionLifecycleContext): Promise<void> {
    for (const handler of this.sessionEnd) {
      try {
        await handler(ctx);
      } catch (err) {
        logHookError(ctx.session, "session_end", err);
      }
    }
  }
}
