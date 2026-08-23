/**
 * Internal turn-loop hook types (issue #297).
 *
 * These are infrastructure only — no external plugin loading.
 */

export interface HookLogger {
  child(domain: string): {
    warn(message: string, opts?: Record<string, unknown>): void;
  };
}

/** Minimal session surface consumed by hook handlers. Avoids importing Session. */
export interface HookSessionLike {
  cwd: string;
  isPlanMode(): boolean;
  /** Runtime logger; typed loosely so Session is assignable without circular imports. */
  getLogger?(): unknown;
  /** `null` means the read index is inactive — skip unread edit_file checks. */
  hasReadPath?(absPath: string): boolean | null;
  listReadPaths?(): string[];
  recentWritesForPath?(absPath: string): Array<{ path: string; turn?: number }>;
}

export type HookPoint =
  | "pre_tool_call"
  | "post_tool_call"
  | "pre_compile"
  | "post_turn"
  | "session_start"
  | "session_end";

export interface PreToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  session: HookSessionLike;
}

export type PreToolCallHandlerResult =
  | void
  | { action?: "continue"; args?: Record<string, unknown> }
  | {
      action: "block";
      error: string;
      isError?: boolean;
      suggestions?: string[];
    };

export type PreToolCallHandler = (
  ctx: PreToolCallContext,
) => PreToolCallHandlerResult | Promise<PreToolCallHandlerResult>;

export type PreToolCallDispatchResult =
  | { action: "continue"; args: Record<string, unknown> }
  | {
      action: "block";
      error: string;
      isError: boolean;
      suggestions?: string[];
    };

export interface PostToolCallContext {
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  isError: boolean;
  session: HookSessionLike;
}

export interface PostToolCallPatch {
  result?: unknown;
  isError?: boolean;
}

export type PostToolCallHandler = (
  ctx: PostToolCallContext,
) => PostToolCallPatch | void | Promise<PostToolCallPatch | void>;

export interface PostToolCallDispatchResult {
  result: unknown;
  isError: boolean;
}

export interface PreCompileContext {
  session: HookSessionLike;
  input: Record<string, unknown>;
}

export type PreCompileHandler = (
  ctx: PreCompileContext,
) => void | Promise<void>;

export interface PostTurnContext {
  session: HookSessionLike;
  turn: number;
}

export type PostTurnHandler = (ctx: PostTurnContext) => void | Promise<void>;

export type SessionLifecycleReason =
  | "create"
  | "resume"
  | "clean"
  | "aborted"
  | "error";

export interface SessionLifecycleContext {
  session: HookSessionLike;
  reason?: SessionLifecycleReason;
}

export type SessionLifecycleHandler = (
  ctx: SessionLifecycleContext,
) => void | Promise<void>;
