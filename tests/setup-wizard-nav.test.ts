import { describe, it, expect } from "bun:test";
import {
  wizardBackTarget,
  wizardFooterHint,
  escHintText,
  nextStepAfterModelChosen,
  type WizardStep,
} from "../src/setup/wizard-nav.js";

/**
 * Every step the wizard component routes through `wizardBackTarget`.
 * `fetch-models` and `oauth-select` are special-cased INSIDE the component
 * (transient no-op / OAuth select cancel) before the target table is
 * consulted, so they are intentionally not part of the table.
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

describe("wizardBackTarget", () => {
  const plain = { isCustom: false, provider: "openai" };
  const custom = { isCustom: true, provider: "mock-provider" };
  const bedrock = { isCustom: false, provider: "amazon-bedrock" };

  it("describes a back target for every reachable step", () => {
    for (const step of ALL_STEPS) {
      const target = wizardBackTarget(step, plain);
      expect(target === "none" || (ALL_STEPS as string[]).includes(target)).toBe(true);
    }
  });

  it("the first (provider) step has no back target — Esc must not quit", () => {
    expect(wizardBackTarget("provider", plain)).toBe("none");
  });

  it("goes back one step at a time from the middle of the flow", () => {
    expect(wizardBackTarget("custom-url", custom)).toBe("custom-id");
    expect(wizardBackTarget("custom-key", custom)).toBe("custom-url");
    expect(wizardBackTarget("key-input", plain)).toBe("key-choice");
    expect(wizardBackTarget("model-picker", plain)).toBe("manual-model");
    expect(wizardBackTarget("manual-model", plain)).toBe("provider");
  });

  it("the memory question comes BEFORE the config confirmation, so back from confirm lands on embedder", () => {
    expect(
      wizardBackTarget("confirm", { ...plain, needsEmbedderConsent: true }),
    ).toBe("embedder");
  });

  it("without a memory question, confirm backs out to the provider list", () => {
    expect(wizardBackTarget("confirm", plain)).toBe("provider");
  });

  it("embedder backs out to the provider list (it precedes confirm)", () => {
    expect(wizardBackTarget("embedder", plain)).toBe("provider");
  });

  it("save-anyway goes back to the input screen that produced it", () => {
    expect(wizardBackTarget("save-anyway", plain)).toBe("key-input");
    expect(wizardBackTarget("save-anyway", custom)).toBe("custom-key");
    expect(wizardBackTarget("save-anyway", bedrock)).toBe("bedrock-key");
  });

  it("provider-choice steps return to the provider list", () => {
    for (const step of ["auth-method", "reuse-oauth", "key-choice", "bedrock-key", "custom-id", "verifying", "oauth-error"] as WizardStep[]) {
      expect(wizardBackTarget(step, plain)).toBe("provider");
    }
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
