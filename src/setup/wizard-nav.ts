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
}

/**
 * Step a back navigation (Esc) should land on from `step`.
 * Returns "none" when the step has nothing to go back to — the first
 * provider step must NOT quit the app; Ctrl+C is the only quit affordance.
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
    case "confirm":
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
    case "embedder":
      // The memory question is the final step; back returns to the config
      // confirmation it was asked from.
      return "confirm";
    case "oauth-text":
    case "oauth-status":
      return "provider";
    case "fetch-models":
      // Transient check — nothing to go back to.
      return "none";
    case "oauth-select":
      return "provider";
  }
}

/**
 * Footer hint for the wizard. Must match the real behaviour on every step:
 * the first step advertises Ctrl+C (Esc does not quit); every other step
 * advertises Esc as back.
 */
export function wizardFooterHint(step: WizardStep): string {
  return step === "provider" ? "Ctrl+C to quit setup" : "esc back · ctrl+c quit";
}

/**
 * Step reached once a model has been chosen. The memory-capability question
 * moved to the end of the wizard (after the config-file confirmation), so
 * picking a model always leads to the confirmation step first.
 */
export function nextStepAfterModelChosen(): WizardStep {
  return "confirm";
}
