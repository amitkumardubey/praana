/**
 * Pure navigation helpers for the interactive setup wizard (setup-wizard.tsx).
 *
 * Kept separate from the Solid component so Esc/back transitions, footer
 * hints, and the step order are unit-testable without rendering a TUI.
 */

export type WizardStep =
  | "provider"
  | "auth-method"
  | "reuse-oauth"
  | "key-choice"
  | "key-input"
  | "bedrock-key"
  | "custom-id"
  | "custom-url"
  | "custom-key"
  | "verifying"
  | "save-anyway"
  | "fetch-models"
  | "model-picker"
  | "manual-model"
  | "embedder"
  | "confirm"
  | "oauth-status"
  | "oauth-text"
  | "oauth-select"
  | "oauth-error";

export interface WizardNavContext {
  /** True while the custom OpenAI-compatible endpoint flow is active. */
  isCustom: boolean;
  /** The provider id being configured ("" before one is chosen). */
  provider: string;
  /**
   * Whether the wizard asked the memory (embedder consent) question before
   * the final config confirmation. When true, Esc from the confirmation
   * returns to that question; otherwise it backs out to the provider list.
   */
  needsEmbedderConsent?: boolean;
}

/**
 * Step a back navigation (Esc) should land on from `step`.
 * Returns "none" when the step has nothing to go back to — the first
 * provider step must NOT quit the app; Ctrl+C is the only quit affordance.
 *
 * Two steps are intentionally absent: `fetch-models` (transient check the
 * component ignores Esc on) and `oauth-select` (Esc cancels the OAuth
 * select via `resolveOAuthSelect(undefined)`). Both are handled inside the
 * component before this table is consulted.
 */
export function wizardBackTarget(
  step: WizardStep,
  ctx: WizardNavContext,
): WizardStep | "none" {
  switch (step) {
    case "provider":
      return "none";
    case "auth-method":
    case "reuse-oauth":
    case "key-choice":
    case "bedrock-key":
    case "custom-id":
    case "verifying":
    case "manual-model":
    case "embedder":
      // The memory question precedes the config confirmation; backing out
      // here restarts the provider flow.
    case "oauth-error":
      return "provider";
    case "key-input":
      return "key-choice";
    case "custom-url":
      return "custom-id";
    case "custom-key":
      return "custom-url";
    case "save-anyway":
      return ctx.isCustom
        ? "custom-key"
        : ctx.provider === "amazon-bedrock"
          ? "bedrock-key"
          : "key-input";
    case "model-picker":
      return "manual-model";
    case "confirm":
      // Nothing is written until the final confirmation is accepted; Esc
      // returns to the memory question when one was asked.
      return ctx.needsEmbedderConsent ? "embedder" : "provider";
    case "oauth-text":
    case "oauth-status":
      return "provider";
    case "fetch-models":
    case "oauth-select":
      // Handled inside the component before this table is consulted (the
      // transient fetch is ignored, and Esc cancels the OAuth select).
      // Defensive fallback: neither can be escaped backward.
      return "none";
  }
}

/**
 * Footer hint for the wizard. Must match the real behaviour on every step:
 * - provider + transient fetch-models: Esc does nothing; Ctrl+C quits.
 * - verifying + OAuth steps: Esc cancels the in-flight operation.
 * - every other step: Esc navigates back one step.
 */
export function wizardFooterHint(step: WizardStep): string {
  switch (step) {
    case "provider":
    case "fetch-models":
      return "Ctrl+C to quit setup";
    case "verifying":
    case "oauth-status":
    case "oauth-text":
    case "oauth-select":
      return "esc cancel · ctrl+c quit";
    default:
      return "esc back · ctrl+c quit";
  }
}

/**
 * Hint text surfaced when Esc is pressed on a step whose back target is
 * "none". Only the first provider step qualifies; every other step returns
 * null so the wizard never routes a hint through its error `message`.
 */
export function escHintText(step: WizardStep): string | null {
  return step === "provider" ? "Ctrl+C to quit setup" : null;
}

/**
 * Step reached once a model has been chosen. The memory question comes
 * BEFORE the config-file confirmation, so picking a model leads to the
 * memory question when interactive consent is still needed, and to the
 * confirmation otherwise. Nothing is written until the confirmation is
 * accepted.
 */
export function nextStepAfterModelChosen(opts?: {
  needsEmbedderConsent?: boolean;
}): WizardStep {
  return opts?.needsEmbedderConsent ? "embedder" : "confirm";
}
