/**
 * Solid OpenTUI setup wizard — provider picker, credential collection, and config creation.
 */
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { createCliRenderer, type InputRenderable } from "@opentui/core";
import { render, useRenderer } from "@opentui/solid";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings } from "@opentui/keymap/solid";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { APP_VERSION } from "../../app-banner.js";
import { renderBootBanner } from "./banner.js";
import { TUI_STYLE } from "./theme.js";
import { Lines } from "./text-lines.js";
import { PaletteList } from "./overlays/picker.js";
import {
  buildProviderSelectItems,
  CUSTOM_PROVIDER_VALUE,
  setupProviderIntroLines,
} from "../../setup/provider-options.js";
import { toPaletteOptions } from "./overlays/picker-items.js";
import {
  adoptEnvKeyForProvider,
  bedrockNeedsApiKeyPrompt,
  embedderConsentToRecord,
  fetchCustomProviderModels,
  fetchProviderModels,
  finalizeProviderSetup,
  formatEnvKeyOfferMessage,
  isValidBaseUrl,
  isValidCustomProviderId,
  pickDefaultModel,
  providerRequiresApiKey,
  providerSupportsOAuth,
  saveProviderKey,
  setupConfigConfirmPrompt,
  verifyProviderKey,
} from "../../setup/logic.js";
import { hasApiKey } from "../../llm.js";
import { hasCredentials, hasOAuthToken } from "../../credentials.js";
import { isOAuthOnlyProvider } from "../../oauth.js";
import { runOAuthLoginWithUi } from "./oauth-login-ui.js";
import { getSetupConfigPath } from "../../setup/config-writer.js";
import type { CustomProviderConfig, SetupResult } from "../../setup/types.js";
import type { ProviderCatalogModelEntry } from "../../provider-catalog.js";
import { upsertUserProvider } from "../../provider-registry.js";
import {
  needsInteractiveEmbedderConsent,
  setEmbedderConsent,
  type EmbedderConsent,
} from "../../memory/embedder-consent.js";
import {
  createWizardHistory,
  escHintText,
  nextStepAfterModelChosen,
  popStep,
  pushStep,
  removeWizardStep,
  resetWizardHistory,
  wizardFooterHint,
  type WizardStep,
} from "../../setup/wizard-nav.js";

const YES_NO_OPTIONS = [
  { value: "yes", name: "Yes", description: "" },
  { value: "no", name: "No", description: "" },
];

const AUTH_METHOD_OPTIONS = [
  { value: "oauth", name: "Claude Pro/Max OAuth", description: "Browser sign-in" },
  { value: "api_key", name: "API key", description: "Paste ANTHROPIC_API_KEY" },
];

const REAUTH_OPTIONS = [
  { value: "yes", name: "Yes — sign in again", description: "" },
  { value: "no", name: "No — keep existing", description: "" },
];

interface WizardState {
  provider: string;
  isCustom: boolean;
  customProviderId: string;
  customBaseUrl: string;
  apiKey: string;
  keySaved: boolean;
  model: string;
  pendingKey: string;
}

export interface RunSetupWizardOptions {
  /** Test-only: pre-scripted input bytes fed to stdin instead of a real TTY. */
  simulateInput?: string[];
}

interface SetupWizardProps {
  onDone: (result: SetupResult) => void;
}

export type { SetupWizardProps };

function versionNumber(): string {
  return APP_VERSION.replace(/^v/, "");
}

function MaskedInput(props: {
  id: string;
  focused?: boolean;
  onSubmit: (value: string) => void;
}) {
  let input: InputRenderable | undefined;
  let actual = "";

  return (
    <input
      id={props.id}
      focused={props.focused}
      ref={(element: InputRenderable) => {
        input = element;
      }}
      onInput={(displayed: string) => {
        const previousDisplay = "•".repeat(actual.length);
        if (displayed.length >= previousDisplay.length) {
          actual += displayed.slice(previousDisplay.length);
        } else {
          actual = actual.slice(0, displayed.length);
        }
        if (input) input.value = "•".repeat(actual.length);
      }}
      onSubmit={() => props.onSubmit(actual)}
    />
  );
}

function TextInput(props: {
  id: string;
  focused?: boolean;
  value?: string;
  onSubmit: (value: string) => void;
}) {
  let input: InputRenderable | undefined;

  return (
    <input
      id={props.id}
      focused={props.focused}
      value={props.value}
      ref={(element: InputRenderable) => {
        input = element;
      }}
      onSubmit={() => props.onSubmit(input?.value ?? "")}
    />
  );
}

export function SetupWizard(props: SetupWizardProps) {
  const renderer = useRenderer();
  const [step, setStep] = createSignal<WizardStep>("provider");
  const [message, setMessage] = createSignal("");
  // Visited-step stack; Esc pops to the previous visited step (see wizard-nav.ts).
  const history = createWizardHistory();
  // Record every landed-on destination (transient steps are skipped by pushStep).
  createEffect(() => {
    pushStep(history, step());
  });
  // Separate non-error hint channel (e.g. "Ctrl+C to quit setup" when Esc is
  // pressed on the first step). Cleared on every step change; never routed
  // through the error `message`.
  const [hint, setHint] = createSignal("");
  createEffect(() => {
    void step();
    setHint("");
  });
  const [models, setModels] = createSignal<ProviderCatalogModelEntry[]>([]);
  const [oauthOptions, setOauthOptions] = createSignal<
    readonly { id: string; label: string; description?: string }[]
  >([]);
  const [oauthPrompt, setOauthPrompt] = createSignal("");
  const [oauthPlaceholder, setOauthPlaceholder] = createSignal("");
  const [oauthContext, setOauthContext] = createSignal<string[]>([]);
  const state: WizardState = {
    provider: "",
    isCustom: false,
    customProviderId: "",
    customBaseUrl: "",
    apiKey: "",
    keySaved: false,
    model: "",
    pendingKey: "",
  };
  let settled = false;
  let oauthAbort: AbortController | undefined;
  let keyVerifyAbort: AbortController | undefined;
  /** Memory-question answer; recorded only when the final confirmation is accepted. */
  let pendingConsent: EmbedderConsent | null = null;
  let resolveOAuthText: ((value: string) => void) | undefined;
  let resolveOAuthSelect: ((value: string | undefined) => void) | undefined;
  const maxVisible = Math.max(5, Math.min(14, (process.stdout.rows ?? 24) - 14));

  // Steps that render a PaletteList; the picker owns the single footer hint
  // line there, so the wizard-level line is suppressed for them.
  const PALETTE_STEPS = new Set<WizardStep>([
    "provider",
    "auth-method",
    "reuse-oauth",
    "key-choice",
    "model-picker",
    "save-anyway",
    "confirm",
    "embedder",
    "oauth-select",
    "oauth-error",
  ]);
  const stepShowsPalette = () => {
    const s = step();
    if (s === "key-choice") {
      return hasApiKey(state.provider) || !!formatEnvKeyOfferMessage(state.provider);
    }
    return PALETTE_STEPS.has(s);
  };

  const providerForConfig = () => (state.isCustom ? state.customProviderId : state.provider);
  const customProvider = (): CustomProviderConfig | undefined =>
    state.isCustom
      ? {
          id: state.customProviderId,
          api: "openai-completions",
          baseUrl: state.customBaseUrl,
          envKey: state.apiKey
            ? `${state.customProviderId.toUpperCase().replace(/-/g, "_")}_API_KEY`
            : undefined,
        }
      : undefined;

  const finish = (result: SetupResult) => {
    if (settled) return;
    settled = true;
    oauthAbort?.abort();
    keyVerifyAbort?.abort();
    props.onDone(result);
  };

  const finalize = (action: "write" | "skip" | "overwrite") => {
    const provider = providerForConfig();
    const custom = customProvider();
    if (custom) {
      upsertUserProvider(custom.id, {
        api: custom.api,
        base_url: custom.baseUrl,
        env_key: custom.envKey,
      });
    }
    const result = finalizeProviderSetup(provider, action, {
      model: state.model || pickDefaultModel(provider) || undefined,
      customProvider: custom,
      keySaved: state.keySaved,
    });
    // The memory question was asked BEFORE this confirmation; record its
    // answer only now that the setup actually completes with a config write.
    // Declining ("skip") or cancelling must leave `.embedder-consent`
    // untouched.
    const consentToRecord = embedderConsentToRecord(pendingConsent, action);
    if (consentToRecord) setEmbedderConsent(consentToRecord);
    finish(result);
  };

  const afterModelChosen = () => {
    setStep(
      nextStepAfterModelChosen({
        needsEmbedderConsent: needsInteractiveEmbedderConsent(),
      }),
    );
  };

  const acceptVerifiedKey = (provider: string, key: string) => {
    saveProviderKey(provider, key);
    state.keySaved = true;
    state.apiKey = key;
    setMessage("");
    setStep("fetch-models");
  };

  const applyKey = async (provider: string, key: string, baseUrl?: string) => {
    const abort = new AbortController();
    keyVerifyAbort?.abort();
    keyVerifyAbort = abort;
    setStep("verifying");
    setMessage("Verifying key…");
    const result = await verifyProviderKey(provider, key, baseUrl ? { baseUrl } : undefined);
    // Stale: the user backed out of verification (Esc), so this result must
    // be ignored — it must not save the key or yank the wizard forward.
    if (abort.signal.aborted) return;
    if (result.status === "unauthorized") {
      setMessage(result.message);
      setStep(
        provider === "amazon-bedrock"
          ? "bedrock-key"
          : state.isCustom
            ? "custom-key"
            : "key-input",
      );
      return;
    }
    if (result.status === "unreachable") {
      state.pendingKey = key;
      setMessage(result.message);
      setStep("save-anyway");
      return;
    }
    acceptVerifiedKey(provider, key);
  };

  const enterKeyInput = () => {
    setMessage("");
    setStep("key-input");
  };

  const selectProvider = (value: string) => {
    if (value === CUSTOM_PROVIDER_VALUE) {
      state.isCustom = true;
      setMessage("");
      setStep("custom-id");
      return;
    }
    state.isCustom = false;
    state.provider = value;
    if (value === "amazon-bedrock") {
      setStep(bedrockNeedsApiKeyPrompt() ? "bedrock-key" : "fetch-models");
    } else if (providerSupportsOAuth(value)) {
      if (isOAuthOnlyProvider(value) && !hasCredentials(value)) void startOAuth(value);
      else setStep(isOAuthOnlyProvider(value) ? "reuse-oauth" : "auth-method");
    } else {
      setStep("key-choice");
    }
  };

  const startOAuth = async (provider: string) => {
    const abort = new AbortController();
    oauthAbort = abort;
    setOauthContext([]);
    setMessage(`Starting OAuth for ${provider}…`);
    setStep("oauth-status");
    try {
      await runOAuthLoginWithUi(provider, {
        signal: abort.signal,
        showStatus: (lines) => {
          setMessage(lines.join("\n"));
          renderer.requestRender();
        },
        promptText: (prompt, placeholder, contextLines) =>
          new Promise<string>((resolve, reject) => {
            if (abort.signal.aborted) {
              reject(new Error("cancelled"));
              return;
            }
            resolveOAuthText = resolve;
            abort.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
            setOauthPrompt(prompt);
            setOauthPlaceholder(placeholder ?? "");
            setOauthContext(contextLines ?? []);
            setStep("oauth-text");
          }),
        promptSelect: (prompt, options) =>
          new Promise<string | undefined>((resolve) => {
            resolveOAuthSelect = resolve;
            setOauthPrompt(prompt);
            setOauthPlaceholder("");
            setOauthOptions(options);
            setStep("oauth-select");
          }),
      });
      if (!abort.signal.aborted) {
        state.keySaved = true;
        setStep("fetch-models");
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        setMessage(`OAuth failed: ${error instanceof Error ? error.message : String(error)}`);
        setStep("oauth-error");
      }
    } finally {
      if (oauthAbort === abort) oauthAbort = undefined;
      resolveOAuthText = undefined;
      resolveOAuthSelect = undefined;
    }
  };

  const goBack = () => {
    const current = step();
    if (current === "oauth-select") {
      resolveOAuthSelect?.(undefined);
      return;
    }
    if (current === "fetch-models") return;
    // Any back navigation invalidates an in-flight key verification so a
    // stale result cannot save the key or yank the wizard forward.
    keyVerifyAbort?.abort();
    const target = popStep(history, current);
    if (target === "none") {
      // First step: Esc must not quit — surface the quit hint on its own
      // channel (never the error message).
      setHint(escHintText(current) ?? "");
      return;
    }
    if (current === "oauth-text" || current === "oauth-status") {
      oauthAbort?.abort();
    }
    // Leaving the "Save anyway?" screen in any direction forgets the
    // refused key so it can never be resurrected by a later Yes.
    if (current === "save-anyway") state.pendingKey = "";
    setMessage("");
    setStep(target);
  };

  useBindings(() => ({
    bindings: [
      { key: "escape", cmd: () => goBack() },
      { key: "ctrl+c", cmd: () => finish({ success: false, message: "Setup cancelled." }) },
    ],
  }));

  createEffect(() => {
    if (step() !== "fetch-models") return;
    const provider = providerForConfig();
    let active = true;
    void (state.isCustom
      ? fetchCustomProviderModels(state.customBaseUrl, state.apiKey || undefined)
      : fetchProviderModels(state.provider)
    ).then((fetched) => {
      if (!active) return;
      setModels(fetched ?? []);
      setStep(fetched && fetched.length > 0 ? "model-picker" : "manual-model");
    });
    onCleanup(() => {
      active = false;
    });
    void provider;
  });

  const submitKey = (value: string) => {
    const key = value.trim();
    if (key) {
      void applyKey(state.provider, key);
    } else if (providerRequiresApiKey(state.provider)) {
      setMessage("API key is required for this provider");
    } else {
      setStep("fetch-models");
    }
  };

  const modelOptions = () =>
    models().map((model) => ({
      value: model.id,
      name: model.id,
      description: model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k context` : "",
    }));

  return (
    <box id="setup-wizard-root" flexDirection="column">
      {step() === "provider" && (
        <>
          <text>
            {setupProviderIntroLines(existsSync(getSetupConfigPath())).join("\n")}
          </text>
          <text> </text>
          <PaletteList
            placeholder="search providers…"
            options={toPaletteOptions(buildProviderSelectItems())}
            maxVisible={maxVisible}
            footerHint={hint() || wizardFooterHint(step())}
            onSelect={(value) => selectProvider(value)}
          />
        </>
      )}

      {step() === "auth-method" && (
        <>
          <text>{`Selected: ${state.provider}`}</text>
          <text> </text>
          <text>How do you want to authenticate?</text>
          <text> </text>
          <PaletteList
            options={AUTH_METHOD_OPTIONS}
            footerHint={hint() || wizardFooterHint(step())}
            onSelect={(value) => {
              if (value === "oauth") void startOAuth(state.provider);
              else if (value === "api_key") setStep("key-choice");
            }}
          />
        </>
      )}

      {step() === "reuse-oauth" && (
        <>
          <text>{`Selected: ${state.provider}`}</text>
          <text> </text>
          <text>
            {hasOAuthToken(state.provider)
              ? "✓ OAuth credentials already stored.\n\nSign in again?"
              : "✓ Credentials already stored.\n\nReplace them?"}
          </text>
          <text> </text>
          <PaletteList
            options={REAUTH_OPTIONS}
            footerHint={hint() || wizardFooterHint(step())}
            onSelect={(value) => {
              if (value === "yes") void startOAuth(state.provider);
              else if (value === "no") {
                state.keySaved = false;
                setStep("fetch-models");
              }
            }}
          />
        </>
      )}

      {step() === "key-choice" && (
        <>
          <text>{`Selected: ${state.provider}`}</text>
          <text> </text>
          {hasApiKey(state.provider) ? (
            <>
              <text><span style={TUI_STYLE.success}>{"✓ API key detected in credential store."}</span></text>
              <text> </text>
              <text>Replace with a new key?</text>
              <text> </text>
              <PaletteList
                options={YES_NO_OPTIONS}
                footerHint={hint() || wizardFooterHint(step())}
                onSelect={(value) => {
                  if (value === "yes") enterKeyInput();
                  else if (value === "no") {
                    state.keySaved = false;
                    setStep("fetch-models");
                  }
                }}
              />
            </>
          ) : formatEnvKeyOfferMessage(state.provider) ? (
            <>
              <text>{formatEnvKeyOfferMessage(state.provider)}</text>
              <text> </text>
              <PaletteList
                options={YES_NO_OPTIONS}
                footerHint={hint() || wizardFooterHint(step())}
                onSelect={(value) => {
                  if (value === "yes") {
                    state.keySaved = adoptEnvKeyForProvider(state.provider);
                    setStep("fetch-models");
                  } else if (value === "no") enterKeyInput();
                }}
              />
            </>
          ) : (
            <>
              <Lines
                lines={[
                  "Paste your API key.",
                  { text: "  Stored in ~/.praana/credentials.json (0600).", style: TUI_STYLE.faint },
                ]}
              />
              <MaskedInput id="setup-key-input" focused onSubmit={submitKey} />
            </>
          )}
        </>
      )}

      {step() === "key-input" && (
        <>
          <text>{`Selected: ${state.provider}`}</text>
          <text> </text>
          <Lines
            lines={[
              "Paste your API key.",
              { text: "  Stored in ~/.praana/credentials.json (0600).", style: TUI_STYLE.faint },
              ...(message() ? ["", { text: `✗ ${message()}`, style: TUI_STYLE.error }] : []),
              "",
            ]}
          />
          <MaskedInput id="setup-key-input" focused onSubmit={submitKey} />
        </>
      )}

      {step() === "bedrock-key" && (
        <>
          <text>Selected: amazon-bedrock</text>
          <text> </text>
          <Lines
            lines={[
              "Paste your Bedrock API key (bearer token).",
              { text: "  Or set AWS credentials / AWS_BEARER_TOKEN_BEDROCK.", style: TUI_STYLE.faint },
              { text: "  Stored in ~/.praana/credentials.json (0600).", style: TUI_STYLE.faint },
              ...(message() ? ["", { text: `✗ ${message()}`, style: TUI_STYLE.error }] : []),
              "",
            ]}
          />
          <MaskedInput
            id="setup-bedrock-key-input"
            focused
            onSubmit={(value) => {
              if (!value.trim()) {
                setMessage("Bedrock API key is required when AWS credentials are not detected");
                return;
              }
              void applyKey("amazon-bedrock", value.trim());
            }}
          />
        </>
      )}

      {step() === "custom-id" && (
        <>
          <text>Custom OpenAI-compatible endpoint</text>
          <text> </text>
          <Lines
            lines={[
              "Enter a provider id (lowercase, no spaces).",
              { text: "  e.g. my-llama, vllm-local, lm-studio", style: TUI_STYLE.faint },
              ...(message() ? ["", { text: `✗ ${message()}`, style: TUI_STYLE.error }] : []),
              "",
            ]}
          />
          <TextInput
            id="setup-custom-id"
            focused
            onSubmit={(value) => {
              const validation = isValidCustomProviderId(value.trim());
              if (!validation.valid) {
                setMessage(validation.error ?? "Invalid provider id");
                return;
              }
              state.customProviderId = value.trim();
              setMessage("");
              setStep("custom-url");
            }}
          />
        </>
      )}

      {step() === "custom-url" && (
        <>
          <text>{`Custom provider: ${state.customProviderId}`}</text>
          <text> </text>
          <Lines
            lines={[
              "Enter the base URL.",
              {
                text: "  e.g. http://localhost:8080/v1, https://api.together.xyz/v1",
                style: TUI_STYLE.faint,
              },
              ...(message() ? ["", { text: `✗ ${message()}`, style: TUI_STYLE.error }] : []),
              "",
            ]}
          />
          <TextInput
            id="setup-custom-url"
            focused
            onSubmit={(value) => {
              const validation = isValidBaseUrl(value.trim());
              if (!validation.valid) {
                setMessage(validation.error ?? "Invalid base URL");
                return;
              }
              state.customBaseUrl = value.trim();
              setMessage("");
              setStep("custom-key");
            }}
          />
        </>
      )}

      {step() === "custom-key" && (
        <>
          <text>{`Custom provider: ${state.customProviderId}`}</text>
          <text> </text>
          <Lines
            lines={[
              "Enter API key (or press Enter to skip for keyless servers).",
              { text: "  Stored in ~/.praana/credentials.json (0600).", style: TUI_STYLE.faint },
            ]}
          />
          <MaskedInput
            id="setup-custom-key"
            focused
            onSubmit={(value) => {
              if (value.trim()) {
                void applyKey(state.customProviderId, value.trim(), state.customBaseUrl);
              } else {
                state.keySaved = false;
                setStep("fetch-models");
              }
            }}
          />
        </>
      )}

      {step() === "fetch-models" && (
        <>
          <text>Fetching models…</text>
          <text> </text>
          <text><span style={TUI_STYLE.faint}>{`  Contacting ${providerForConfig()}…`}</span></text>
        </>
      )}

      {step() === "model-picker" && (
        <>
          <text>{`Pick a default model for ${providerForConfig()}`}</text>
          <text> </text>
          <PaletteList
            placeholder="search models…"
            options={modelOptions()}
            maxVisible={maxVisible}
            footerHint={hint() || wizardFooterHint(step())}
            onSelect={(value) => {
              state.model = value;
              afterModelChosen();
            }}
          />
        </>
      )}

      {step() === "manual-model" && (
        <>
          <text>{`Enter model id for ${providerForConfig()}`}</text>
          <text> </text>
          <Lines
            lines={[
              "Enter the model id to use as default.",
              pickDefaultModel(providerForConfig())
                ? {
                    text: `  Press Enter for default: ${pickDefaultModel(providerForConfig())}`,
                    style: TUI_STYLE.faint,
                  }
                : { text: "  e.g. llama-3.1-8b-instruct", style: TUI_STYLE.faint },
            ]}
          />
          <TextInput
            id="setup-custom-model"
            focused
            value={pickDefaultModel(providerForConfig())}
            onSubmit={(value) => {
              state.model = value.trim() || pickDefaultModel(providerForConfig()) || "";
              afterModelChosen();
            }}
          />
        </>
      )}

      {step() === "verifying" && (
        <>
          <text><span style={TUI_STYLE.info}>Verifying API key…</span></text>
          <text> </text>
          <text><span style={TUI_STYLE.faint}>{message() || "Contacting provider…"}</span></text>
        </>
      )}

      {step() === "save-anyway" && (
        <>
          <text><span style={TUI_STYLE.error}>{message() || "Could not verify this key."}</span></text>
          <text> </text>
          <text>Save anyway and continue?</text>
          <text> </text>
          <PaletteList
            options={[
              { value: "yes", name: "Yes — save anyway", description: "" },
              { value: "no", name: "No — re-enter key", description: "" },
            ]}
            footerHint={hint() || wizardFooterHint(step())}
            onSelect={(value) => {
              if (value === "yes") {
                acceptVerifiedKey(providerForConfig(), state.pendingKey);
                // The key was accepted and saved; forget it and drop this
                // step from the visited history so Esc cannot walk back onto
                // a stale "Save anyway?" screen.
                state.pendingKey = "";
                removeWizardStep(history, "save-anyway");
              } else if (value === "no") {
                // Refused: forget the key and drop the step so Esc cannot
                // resurface it (and Yes cannot overwrite a later good key).
                state.pendingKey = "";
                removeWizardStep(history, "save-anyway");
                setMessage("");
                setStep(state.isCustom ? "custom-key" : state.provider === "amazon-bedrock" ? "bedrock-key" : "key-input");
              }
            }}
          />
        </>
      )}

      {step() === "confirm" && (
        <>
          <text>{`Selected: ${providerForConfig()}`}</text>
          <text> </text>
          <Lines
            lines={[
              [
                "Provider: ",
                { text: providerForConfig(), style: TUI_STYLE.success },
              ],
              state.model ? `Model: ${state.model}` : "Model: (auto-detect)",
              state.keySaved
                ? ["Key: ", { text: "saved to credential store", style: TUI_STYLE.success }]
                : hasApiKey(providerForConfig())
                  ? ["Key: ", { text: "in credential store", style: TUI_STYLE.success }]
                  : "Key: (not set)",
              ...(pendingConsent === "proceed"
                ? [
                    ["Memory recall: ", { text: "Download now", style: TUI_STYLE.success }],
                  ]
                : pendingConsent === "skip"
                  ? [
                      ["Memory recall: ", { text: "Keyword only", style: TUI_STYLE.muted }],
                    ]
                  : []),
              "",
              setupConfigConfirmPrompt(existsSync(getSetupConfigPath())),
            ]}
          />
          <text> </text>
          <PaletteList
            options={YES_NO_OPTIONS}
            footerHint={hint() || wizardFooterHint(step())}
            onSelect={(value) => {
              if (value === "no") finalize("skip");
              else if (value === "yes") finalize("write");
            }}
          />
        </>
      )}

      {step() === "embedder" && (
        <>
          <text><span style={TUI_STYLE.info}>Smarter memory recall?</span></text>
          <text> </text>
          <Lines
            lines={[
              "PRAANA remembers things across sessions. A small local model (about 38 MB, downloaded once from HuggingFace) makes recall smarter.",
              "You can skip it and keep plain keyword search; change this later in config.",
            ]}
          />
          <text> </text>
          <PaletteList
            options={[
              {
                value: "proceed",
                name: "Download now (recommended)",
                description: "Download once from HuggingFace",
              },
              {
                value: "skip",
                name: "Skip: keyword search only",
                description: "No download — plain keyword search",
              },
            ]}
            footerHint={hint() || wizardFooterHint(step())}
            onSelect={(value) => {
              if (value === "proceed" || value === "skip") {
                pendingConsent = value;
                setStep("confirm");
              }
            }}
          />
        </>
      )}

      {step() === "oauth-status" && (
        <>
          <text>{`OAuth: ${state.provider}`}</text>
          <text> </text>
          <text>{message()}</text>
          <text><span style={TUI_STYLE.faint}>{"Esc to cancel"}</span></text>
        </>
      )}

      {step() === "oauth-text" && (
        <>
          <text>{`OAuth: ${state.provider}`}</text>
          <text> </text>
          <text>{[...oauthContext(), oauthPrompt()].filter(Boolean).join("\n\n")}</text>
          <Show when={oauthPlaceholder()}>
            <text><span style={TUI_STYLE.muted}>{oauthPlaceholder()}</span></text>
          </Show>
          <text> </text>
          <TextInput
            id="setup-oauth-input"
            focused
            onSubmit={(value) => {
              if (value.trim()) resolveOAuthText?.(value.trim());
            }}
          />
          <text><span style={TUI_STYLE.faint}>{"Paste · Enter · Esc cancel"}</span></text>
        </>
      )}

      {step() === "oauth-select" && (
        <>
          <text>{`OAuth: ${state.provider}`}</text>
          <text> </text>
          <text>{oauthPrompt()}</text>
          <text> </text>
          <PaletteList
            options={oauthOptions().map((option) => ({
              name: option.label,
              description: option.description ?? "",
              value: option.id,
            }))}
            footerHint={hint() || wizardFooterHint(step())}
            onSelect={(value) => resolveOAuthSelect?.(value)}
          />
        </>
      )}

      {step() === "oauth-error" && (
        <>
          <text>{`OAuth: ${state.provider}`}</text>
          <text> </text>
          <text>{message()}</text>
          <text> </text>
          <PaletteList
            options={[{ name: "Back to provider list", description: "", value: "back" }]}
            footerHint={hint() || wizardFooterHint(step())}
            onSelect={() => {
              resetWizardHistory(history);
              setStep("provider");
            }}
          />
        </>
      )}

      <Show when={!stepShowsPalette()}>
        <text>
          <span style={TUI_STYLE.muted}>{wizardFooterHint(step())}</span>
        </text>
      </Show>
    </box>
  );
}

/** Run the interactive setup wizard in a standalone Solid OpenTUI session. */
export async function runSetupWizardTui(options?: RunSetupWizardOptions): Promise<SetupResult> {
  const stdin = options?.simulateInput
    ? createMockStdin(options.simulateInput)
    : (process.stdin as unknown as NodeJS.ReadStream);
  const renderer = await createCliRenderer({
    stdin,
    stdout: process.stdout,
    width: process.stdout.columns ?? 80,
    height: process.stdout.rows ?? 24,
    exitOnCtrlC: false,
  });
  const keymap = createDefaultOpenTuiKeymap(renderer);

  const bannerLines = renderBootBanner({
    version: versionNumber(),
    summaryLines: ["Provider Setup"],
    width: process.stdout.columns ?? 80,
    noColor: !!process.env.NO_COLOR,
    banner: true,
  });
  for (const line of bannerLines) process.stdout.write(`${line}\n`);

  try {
    return await new Promise<SetupResult>((resolve) => {
      void render(
        () => (
          <KeymapProvider keymap={keymap}>
            <SetupWizard onDone={resolve} />
          </KeymapProvider>
        ),
        renderer,
      );
    });
  } finally {
    renderer.destroy();
  }
}

function createMockStdin(chunks: string[]): NodeJS.ReadStream {
  return Readable.from(chunks) as unknown as NodeJS.ReadStream;
}
