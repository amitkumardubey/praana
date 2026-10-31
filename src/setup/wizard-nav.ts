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

/**
 * Visited-step history for the wizard. Esc pops to the PREVIOUS visited
 * step instead of consulting a static back table, so it lands on the step
 * the user actually came from (e.g. the memory question goes back to the
 * model step that was used, model-picker goes back to the fetch/key step).
 */
export interface WizardHistory {
  /** Visited destination steps, oldest first. Never contains transient steps. */
  steps: WizardStep[];
}

/**
 * Steps that are intermediate/transient — they render while async work is
 * running (key verification, model fetch) or while an OAuth interstitial is
 * showing. They are not destinations a back navigation should restore, so
 * they are never recorded in the history.
 */
const TRANSIENT_STEPS: ReadonlySet<WizardStep> = new Set([
  "verifying",
  "fetch-models",
  "oauth-status",
  "oauth-text",
  "oauth-select",
]);

export function createWizardHistory(): WizardHistory {
  return { steps: [] };
}

/**
 * Record that the wizard landed on `step`. Transient steps are skipped, and
 * re-entering the same step consecutively collapses (e.g. returning to the
 * key screen after a failed verification must not grow the stack).
 */
export function pushStep(history: WizardHistory, step: WizardStep): void {
  if (TRANSIENT_STEPS.has(step)) return;
  if (history.steps[history.steps.length - 1] === step) return;
  history.steps.push(step);
}

/**
 * Resolve where Esc should land from the current `step`. Pops the current
 * step off the history when it is a visited destination and returns the
 * previous one; when the wizard is on a transient step (verifying, model
 * fetch, OAuth interstitial) the last visited destination is returned
 * without popping — the user never left it. Returns "none" at the first
 * provider step: Esc must not quit, the component surfaces the hint.
 */
export function popStep(
  history: WizardHistory,
  current: WizardStep,
): WizardStep | "none" {
  const last = history.steps[history.steps.length - 1];
  if (last === undefined || history.steps.length <= 1) return "none";
  if (last === current) {
    history.steps.pop();
    return history.steps[history.steps.length - 1] ?? "none";
  }
  return last;
}

/**
 * Clear the history. Used when an explicit action restarts the flow from
 * the provider step (e.g. "Back to provider list" on the OAuth error step)
 * so stale visited steps cannot resurface on later Esc presses.
 */
export function resetWizardHistory(history: WizardHistory): void {
  history.steps = [];
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
