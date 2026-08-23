import { createPlanModePreToolCallHandler } from "./handlers/plan-mode.js";
import {
  WritePathGuard,
  createWritePathPostToolCallHandler,
  createWritePathPreToolCallHandler,
} from "./handlers/write-path.js";
import { createLspEditHandlers } from "./handlers/lsp.js";
import { createVerifyPostToolCallHandler } from "./handlers/verify.js";
import { createValidateHandlers } from "./handlers/validate.js";
import { createRiskPreToolCallHandler } from "./handlers/risk.js";
import { HookRegistry } from "./registry.js";
import type { LspManager } from "../lsp/manager.js";
import type { VerifyConfig } from "../types.js";
import type { ListImportsFn } from "../verify/import-graph.js";
import type { ParseFileFn } from "../verify/syntax.js";
import type { RunTestsFn } from "../verify/test-impact.js";
import type { RunTypecheckFn } from "../verify/typecheck.js";

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
export { createVerifyPostToolCallHandler } from "./handlers/verify.js";
export { createValidateHandlers } from "./handlers/validate.js";
export { toolResultFromPreBlock } from "./block-result.js";

export interface VerifyHookDeps {
  parseFile?: ParseFileFn | null;
  listImports?: ListImportsFn | null;
  runTypecheck?: RunTypecheckFn;
  runTests?: RunTestsFn;
}

export interface ValidateHookDeps {
  pathExists?: (absPath: string) => boolean;
  listRepoFiles?: () => string[];
  commandOnPath?: (name: string) => boolean;
}

export interface BuiltinHookOptions {
  lspManager?: LspManager | null;
  onFormattedPath?: (absPath: string) => void;
  verify?: VerifyConfig;
  verifyDeps?: VerifyHookDeps;
  validate?: ValidateHookDeps;
}

/**
 * Register plan-mode, validate, risk, write-path, then LSP / verify (before lock release).
 * Order: pre = plan → validate → risk → write-path acquire → lsp snapshot
 *        post = lsp post-edit → verify → enrich → write-path release
 */
export function registerBuiltinHooks(
  registry: HookRegistry,
  cwd: string,
  opts?: BuiltinHookOptions,
): void {
  const writePath = new WritePathGuard(cwd);
  registry.onPreToolCall(createPlanModePreToolCallHandler());
  const validate = createValidateHandlers({
    cwd,
    pathExists: opts?.validate?.pathExists,
    listRepoFiles: opts?.validate?.listRepoFiles,
    commandOnPath: opts?.validate?.commandOnPath,
  });
  registry.onPreToolCall(validate.pre);
  registry.onPreToolCall(createRiskPreToolCallHandler(cwd));
  registry.onPreToolCall(
    createWritePathPreToolCallHandler(writePath, {
      originatingPathForApply: (id) =>
        opts?.lspManager?.originatingPathForAction(id) ?? null,
    }),
  );

  if (opts?.lspManager) {
    opts.lspManager.setApplyLock({
      tryAcquireExtra: (id, absPath) =>
        writePath.tryAcquireExtra(id, absPath, absPath),
    });
    const lspHandlers = createLspEditHandlers({
      cwd,
      getLsp: () => opts.lspManager ?? null,
      onFormattedPath: opts.onFormattedPath,
    });
    registry.onPreToolCall(lspHandlers.pre);
    registry.onPostToolCall(lspHandlers.post);
  }

  registry.onPostToolCall(
    createVerifyPostToolCallHandler({
      cwd,
      getConfig: () => opts?.verify,
      parseFile: opts?.verifyDeps?.parseFile,
      listImports: opts?.verifyDeps?.listImports,
      runTypecheck: opts?.verifyDeps?.runTypecheck,
      runTests: opts?.verifyDeps?.runTests,
    }),
  );

  registry.onPostToolCall(validate.post);
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
