import { createPlanModePreToolCallHandler } from "./handlers/plan-mode.js";
import {
  WritePathGuard,
  createWritePathPostToolCallHandler,
  createWritePathPreToolCallHandler,
} from "./handlers/write-path.js";
import { createLspEditHandlers } from "./handlers/lsp.js";
import { HookRegistry } from "./registry.js";
import type { LspManager } from "../lsp/manager.js";

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

export interface BuiltinHookOptions {
  lspManager?: LspManager | null;
  onFormattedPath?: (absPath: string) => void;
}

/**
 * Register plan-mode, write-path, then LSP post-edit (before lock release).
 * Order: pre = plan → write-path acquire → lsp snapshot
 *        post = lsp post-edit → write-path release
 */
export function registerBuiltinHooks(
  registry: HookRegistry,
  cwd: string,
  opts?: BuiltinHookOptions,
): void {
  const writePath = new WritePathGuard(cwd);
  registry.onPreToolCall(createPlanModePreToolCallHandler());
  registry.onPreToolCall(createWritePathPreToolCallHandler(writePath));

  if (opts?.lspManager) {
    const lspHandlers = createLspEditHandlers({
      cwd,
      getLsp: () => opts.lspManager ?? null,
      onFormattedPath: opts.onFormattedPath,
    });
    registry.onPreToolCall(lspHandlers.pre);
    registry.onPostToolCall(lspHandlers.post);
  }

  registry.onPostToolCall(createWritePathPostToolCallHandler(writePath));
}

export function createBuiltinHookRegistry(
  cwd: string,
  opts?: BuiltinHookOptions,
): HookRegistry {
  const registry = new HookRegistry();
  registerBuiltinHooks(registry, cwd, opts);
  return registry;
}
