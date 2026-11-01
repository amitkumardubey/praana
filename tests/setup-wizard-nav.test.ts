import { describe, it, expect } from "bun:test";
import {
  wizardFooterHint,
  escHintText,
  nextStepAfterModelChosen,
  createWizardHistory,
  pushStep,
  popStep,
  resetWizardHistory,
  removeWizardStep,
  type WizardStep,
} from "../src/setup/wizard-nav.js";

/**
 * Every step the wizard component routes through the navigation history.
 * `fetch-models`, `verifying` and the OAuth interstitial steps are transient
 * and never recorded; `oauth-select` Esc cancels the select inside the
 * component instead of navigating back.
 */
const ALL_STEPS: WizardStep[] = [
  "provider",
  "auth-method",
  "reuse-oauth",
  "key-choice",
  "key-input",
  "bedrock-key",
  "custom-id",
  "custom-url",
  "custom-key",
  "verifying",
  "save-anyway",
  "model-picker",
  "manual-model",
  "embedder",
  "confirm",
  "oauth-status",
  "oauth-text",
  "oauth-error",
];

describe("wizard history (pushStep/popStep)", () => {
  it("records visited steps in order and pops back through them", () => {
    const h = createWizardHistory();
    pushStep(h, "provider");
    pushStep(h, "custom-id");
    pushStep(h, "custom-url");
    pushStep(h, "custom-key");
    expect(popStep(h, "custom-key")).toBe("custom-url");
    expect(popStep(h, "custom-url")).toBe("custom-id");
    expect(popStep(h, "custom-id")).toBe("provider");
    expect(popStep(h, "provider")).toBe("none");
  });

  it("never records transient steps (verifying/fetch-models/oauth interstitials)", () => {
    const h = createWizardHistory();
    pushStep(h, "provider");
    pushStep(h, "key-input");
    pushStep(h, "verifying");
    pushStep(h, "fetch-models");
    pushStep(h, "oauth-status");
    pushStep(h, "oauth-text");
    pushStep(h, "oauth-select");
    expect(h.steps).toEqual(["provider", "key-input"]);
    // Esc from a transient step returns to the last visited destination
    // without popping it — the user never left it.
    expect(popStep(h, "verifying")).toBe("key-input");
    expect(popStep(h, "key-input")).toBe("provider");
  });

  it("esc from the memory question returns to the model step the user actually used", () => {
    const h = createWizardHistory();
    for (const s of ["provider", "key-choice", "model-picker", "embedder"] as const) pushStep(h, s);
    expect(popStep(h, "embedder")).toBe("model-picker");
  });

  it("model-picker esc never invents the manual entry unless it was visited", () => {
    const h = createWizardHistory();
    pushStep(h, "provider");
    pushStep(h, "key-choice");
    pushStep(h, "model-picker");
    expect(popStep(h, "model-picker")).toBe("key-choice");

    const h2 = createWizardHistory();
    pushStep(h2, "provider");
    pushStep(h2, "key-choice");
    pushStep(h2, "manual-model");
    pushStep(h2, "model-picker");
    expect(popStep(h2, "model-picker")).toBe("manual-model");
  });

  it("consecutive repeats collapse so failed-verification re-entry does not grow the stack", () => {
    const h = createWizardHistory();
    pushStep(h, "provider");
    pushStep(h, "key-input");
    pushStep(h, "key-input");
    expect(h.steps).toEqual(["provider", "key-input"]);
  });

  it("explicit reset clears the history (back-to-provider actions)", () => {
    const h = createWizardHistory();
    pushStep(h, "provider");
    pushStep(h, "auth-method");
    resetWizardHistory(h);
    expect(h.steps).toEqual([]);
  });

  it("the first provider step stays a no-op with the hint", () => {
    const h = createWizardHistory();
    pushStep(h, "provider");
    expect(popStep(h, "provider")).toBe("none");
  });

  it("esc from an OAuth interstitial started straight from the provider list returns to the provider", () => {
    // Codex/Copilot skip the auth-method step: the stack stays [provider]
    // while the OAuth browser/paste screens show. Esc there must still
    // resolve to the provider (so the component can abort), not to "none".
    const h = createWizardHistory();
    pushStep(h, "provider");
    expect(popStep(h, "oauth-status")).toBe("provider");
    expect(popStep(h, "oauth-text")).toBe("provider");
    expect(popStep(h, "oauth-select")).toBe("provider");
    // Transients are still never recorded — the provider stays the only entry.
    expect(h.steps).toEqual(["provider"]);
  });

  it("transient steps resolve to the last visited destination without popping", () => {
    const h = createWizardHistory();
    pushStep(h, "provider");
    pushStep(h, "auth-method");
    for (const step of ["verifying", "fetch-models", "oauth-status", "oauth-text", "oauth-select"] as const) {
      expect(popStep(h, step)).toBe("auth-method");
    }
    expect(h.steps).toEqual(["provider", "auth-method"]);
  });

  it("a non-transient step on a single-entry history reports none", () => {
    const h = createWizardHistory();
    pushStep(h, "provider");
    expect(popStep(h, "provider")).toBe("none");
    expect(popStep(h, "auth-method")).toBe("none");
  });

  it("removeWizardStep drops a resolved step so it cannot resurface as a back target", () => {
    const h = createWizardHistory();
    pushStep(h, "provider");
    pushStep(h, "key-choice");
    pushStep(h, "save-anyway");
    removeWizardStep(h, "save-anyway");
    expect(h.steps).toEqual(["provider", "key-choice"]);
    // Esc from the key screen afterwards must not walk back onto save-anyway.
    pushStep(h, "key-input");
    expect(popStep(h, "key-input")).toBe("key-choice");
  });
});

describe("wizardFooterHint", () => {
  it("first step advertises Ctrl+C to quit (Esc does not quit)", () => {
    expect(wizardFooterHint("provider")).toBe("Ctrl+C to quit setup");
  });

  it("transient fetch-models cannot be escaped backward — no 'esc back' claim", () => {
    expect(wizardFooterHint("fetch-models")).toBe("Ctrl+C to quit setup");
  });

  it("verifying and OAuth steps cancel on Esc, not navigate back", () => {
    for (const step of ["verifying", "oauth-status", "oauth-text", "oauth-select"] as WizardStep[]) {
      expect(wizardFooterHint(step)).toBe("esc cancel · ctrl+c quit");
    }
  });

  it("every other step advertises Esc as back", () => {
    for (const step of ALL_STEPS) {
      if (["provider", "verifying", "oauth-status", "oauth-text", "oauth-select"].includes(step)) continue;
      expect(wizardFooterHint(step)).toBe("esc back · ctrl+c quit");
    }
  });
});

describe("escHintText", () => {
  it("surfaces the quit hint only on the first (provider) step", () => {
    expect(escHintText("provider")).toBe("Ctrl+C to quit setup");
  });

  it("returns null on every other step — Esc there must never reuse the error channel", () => {
    for (const step of ALL_STEPS) {
      if (step === "provider") continue;
      expect(escHintText(step)).toBeNull();
    }
  });
});

describe("nextStepAfterModelChosen", () => {
  it("always goes to the memory question first when interactive consent is needed", () => {
    expect(nextStepAfterModelChosen({ needsEmbedderConsent: true })).toBe("embedder");
  });

  it("goes straight to the config confirmation when no memory question is needed", () => {
    expect(nextStepAfterModelChosen({ needsEmbedderConsent: false })).toBe("confirm");
    expect(nextStepAfterModelChosen()).toBe("confirm");
  });
});
