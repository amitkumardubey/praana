import { describe, it, expect } from "bun:test";
import {
  wizardBackTarget,
  wizardFooterHint,
  nextStepAfterModelChosen,
  type WizardStep,
} from "../src/setup/wizard-nav.js";

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
  "fetch-models",
  "model-picker",
  "manual-model",
  "embedder",
  "confirm",
  "oauth-status",
  "oauth-text",
  "oauth-select",
  "oauth-error",
];

describe("wizardBackTarget", () => {
  const plain = { isCustom: false, provider: "openai" };
  const custom = { isCustom: true, provider: "mock-provider" };
  const bedrock = { isCustom: false, provider: "amazon-bedrock" };

  it("describes a back target for every step", () => {
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

  it("the memory question sits after the config confirmation, so back lands on confirm", () => {
    expect(wizardBackTarget("embedder", plain)).toBe("confirm");
  });

  it("save-anyway goes back to the input screen that produced it", () => {
    expect(wizardBackTarget("save-anyway", plain)).toBe("key-input");
    expect(wizardBackTarget("save-anyway", custom)).toBe("custom-key");
    expect(wizardBackTarget("save-anyway", bedrock)).toBe("bedrock-key");
  });

  it("provider-choice steps return to the provider list", () => {
    for (const step of ["auth-method", "reuse-oauth", "key-choice", "bedrock-key", "custom-id", "verifying", "confirm", "oauth-error"] as WizardStep[]) {
      expect(wizardBackTarget(step, plain)).toBe("provider");
    }
  });

  it("transient fetch-models cannot be escaped backward", () => {
    expect(wizardBackTarget("fetch-models", plain)).toBe("none");
  });
});

describe("wizardFooterHint", () => {
  it("first step advertises Ctrl+C to quit (Esc does not quit)", () => {
    expect(wizardFooterHint("provider")).toBe("Ctrl+C to quit setup");
  });

  it("every other step advertises Esc as back", () => {
    for (const step of ALL_STEPS) {
      if (step === "provider") continue;
      expect(wizardFooterHint(step)).toBe("esc back · ctrl+c quit");
    }
  });
});

describe("nextStepAfterModelChosen", () => {
  it("always goes to the config confirmation (memory question moved to the end)", () => {
    expect(nextStepAfterModelChosen()).toBe("confirm");
  });
});
