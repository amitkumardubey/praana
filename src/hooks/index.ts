import { createPlanModePreToolCallHandler } from "./handlers/plan-mode.js";
import {
  WritePathGuard,
  createWritePathPostToolCallHandler,
  createWritePathPreToolCallHandler,
} from "./handlers/write-path.js";
import { HookRegistry } from "./registry.js";

export { HookRegistry } from "./registry.js";
export type {
  HookLogger,
  HookPoint,
  HookSessionLike,
  PostToolCallContext,
  PostToolCallDispatchResult,
  PostToolCallHandler,
  PostToolCallPatch,
  PostTurnContext,
  PostTurnHandler,
  PreCompileContext,
  PreCompileHandler,
  PreToolCallContext,
  PreToolCallDispatchResult,
  PreToolCallHandler,
  PreToolCallHandlerResult,
  SessionLifecycleContext,
  SessionLifecycleHandler,
  SessionLifecycleReason,
} from "./types.js";
export { PLAN_MODE_BLOCK_ERROR } from "./handlers/plan-mode.js";
export { WritePathGuard } from "./handlers/write-path.js";

/** Register plan-mode then write-path (plan denial must not acquire locks). */
export function registerBuiltinHooks(registry: HookRegistry, cwd: string): void {
  const writePath = new WritePathGuard(cwd);
  registry.onPreToolCall(createPlanModePreToolCallHandler());
  registry.onPreToolCall(createWritePathPreToolCallHandler(writePath));
  registry.onPostToolCall(createWritePathPostToolCallHandler(writePath));
}

export function createBuiltinHookRegistry(cwd: string): HookRegistry {
  const registry = new HookRegistry();
  registerBuiltinHooks(registry, cwd);
  return registry;
}
