/**
 * Solid OpenTUI setup wizard — provider picker, credential collection, and config creation.
 */
import { createEffect, createSignal, onCleanup } from "solid-js";
import { createCliRenderer, type InputRenderable, type KeyEvent } from "@opentui/core";
import { render, useRenderer } from "@opentui/solid";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { APP_VERSION } from "../../app-banner.js";
import { renderBootBanner } from "./banner.js";
import { TUI_STYLE } from "./theme.js";
import {
  buildProviderSelectItems,
  CUSTOM_PROVIDER_VALUE,
  formatDetectedProviderLines,
} from "../../setup/provider-options.js";
import {
  adoptEnvKeyForProvider,
  bedrockNeedsApiKeyPrompt,
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
} from "../../setup/logic.js";
import { hasApiKey } from "../../llm.js";
import { hasCredentials, hasOAuthToken } from "../../credentials.js";
import { isOAuthOnlyProvider } from "../../oauth.js";
import { runOAuthLoginWithUi } from "./oauth-login-ui.js";
import { getSetupConfigPath } from "../../setup/config-writer.js";
import type { CustomProviderConfig, SetupResult } from "../../setup/types.js";
import type { ProviderCatalogModelEntry } from "../../provider-catalog.js";

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

type Step =
  | "provider"
  | "auth-method"
  | "reuse-oauth"
  | "key-choice"
  | "key-input"
  | "bedrock-key"
  | "custom-id"
  | "custom-url"
  | "custom-key"
  | "fetch-models"
  | "model-picker"
  | "manual-model"
  | "confirm"
  | "overwrite"
  | "oauth-status"
  | "oauth-text"
  | "oauth-select"
  | "oauth-error";

interface WizardState {
  provider: string;
  isCustom: boolean;
  customProviderId: string;
  customBaseUrl: string;
  apiKey: string;
  keySaved: boolean;
  model: string;
}

export interface RunSetupWizardOptions {
  /** Test-only: pre-scripted input bytes fed to stdin instead of a real TTY. */
  simulateInput?: string[];
}

interface SetupWizardProps {
  onDone: (result: SetupResult) => void;
}

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

function SetupWizard(props: SetupWizardProps) {
  const renderer = useRenderer();
  const [step, setStep] = createSignal<Step>("provider");
  const [message, setMessage] = createSignal("");
  const [models, setModels] = createSignal<ProviderCatalogModelEntry[]>([]);
  const [oauthOptions, setOauthOptions] = createSignal<
    readonly { id: string; label: string; description?: string }[]
  >([]);
  const [oauthPrompt, setOauthPrompt] = createSignal("");
  const [oauthContext, setOauthContext] = createSignal<string[]>([]);
  const state: WizardState = {
    provider: "",
    isCustom: false,
    customProviderId: "",
    customBaseUrl: "",
    apiKey: "",
    keySaved: false,
    model: "",
  };
  let settled = false;
  let oauthAbort: AbortController | undefined;
  let resolveOAuthText: ((value: string) => void) | undefined;
  let resolveOAuthSelect: ((value: string | undefined) => void) | undefined;
  const maxVisible = Math.max(5, Math.min(14, (process.stdout.rows ?? 24) - 14));

  const providerForConfig = () => (state.isCustom ? state.customProviderId : state.provider);
  const customProvider = (): CustomProviderConfig | undefined =>
    state.isCustom
      ? {
          id: state.customProviderId,
          api: "openai-completions",
          baseUrl: state.customBaseUrl,
        }
      : undefined;

  const finish = (result: SetupResult) => {
    if (settled) return;
    settled = true;
    oauthAbort?.abort();
    props.onDone(result);
  };

  const finalize = (action: "write" | "skip" | "overwrite") => {
    const provider = providerForConfig();
    finish(
      finalizeProviderSetup(provider, action, {
        model: state.model || pickDefaultModel(provider) || undefined,
        customProvider: customProvider(),
        keySaved: state.keySaved,
      }),
    );
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
            setOauthPrompt(placeholder ? `${prompt}\n${TUI_STYLE.muted(placeholder)}` : prompt);
            setOauthContext(contextLines ?? []);
            setStep("oauth-text");
          }),
        promptSelect: (prompt, options) =>
          new Promise<string | undefined>((resolve) => {
            resolveOAuthSelect = resolve;
            setOauthPrompt(prompt);
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
        setMessage(
          TUI_STYLE.error(`OAuth failed: ${error instanceof Error ? error.message : String(error)}`),
        );
        setStep("oauth-error");
      }
    } finally {
      if (oauthAbort === abort) oauthAbort = undefined;
      resolveOAuthText = undefined;
      resolveOAuthSelect = undefined;
    }
  };

  const goBack = () => {
    switch (step()) {
      case "provider":
        finish({ success: false, message: "Setup cancelled." });
        break;
      case "auth-method":
      case "reuse-oauth":
      case "key-choice":
      case "key-input":
      case "bedrock-key":
      case "custom-id":
      case "oauth-error":
        setStep("provider");
        break;
      case "custom-url":
        setStep("custom-id");
        break;
      case "custom-key":
        setStep("custom-url");
        break;
      case "model-picker":
        setStep("manual-model");
        break;
      case "manual-model":
        setStep("provider");
        break;
      case "confirm":
        setStep("provider");
        break;
      case "overwrite":
        setStep("confirm");
        break;
      case "oauth-text":
        oauthAbort?.abort();
        setStep("provider");
        break;
      case "oauth-select":
        resolveOAuthSelect?.(undefined);
        break;
      case "oauth-status":
        oauthAbort?.abort();
        setStep("provider");
        break;
      case "fetch-models":
        break;
    }
  };

  createEffect(() => {
    const onKey = (key: KeyEvent) => {
      if (key.name === "escape") {
        key.preventDefault();
        goBack();
      } else if (key.name === "c" && key.ctrl) {
        key.preventDefault();
        finish({ success: false, message: "Setup cancelled." });
      }
    };
    renderer.keyInput.on("keypress", onKey);
    onCleanup(() => renderer.keyInput.off("keypress", onKey));
  });

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
      saveProviderKey(state.provider, key);
      state.keySaved = true;
      setStep("fetch-models");
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
            {[
              "No provider configured. Let's set one up.",
              "",
              ...formatDetectedProviderLines(),
              ...(formatDetectedProviderLines().length > 0 ? [""] : []),
              "Choose a provider:",
            ].join("\n")}
          </text>
          <text> </text>
          <select
            id="provider-picker-list"
            focused
            width={40}
            height={maxVisible}
            options={buildProviderSelectItems().map((item) => ({
              name: item.label,
              description: item.description ?? "",
              value: item.value,
            }))}
            showScrollIndicator
            onSelect={(_index, option) => {
              if (option && typeof option.value === "string") selectProvider(option.value);
            }}
          />
        </>
      )}

      {step() === "auth-method" && (
        <>
          <text>{`Selected: ${state.provider}`}</text>
          <text> </text>
          <text>How do you want to authenticate?</text>
          <text> </text>
          <select
            id="setup-auth-method"
            focused
            width={40}
            height={6}
            options={AUTH_METHOD_OPTIONS}
            onSelect={(_index, option) => {
              if (option?.value === "oauth") void startOAuth(state.provider);
              else if (option?.value === "api_key") setStep("key-choice");
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
          <select
            id="setup-reuse-oauth"
            focused
            width={40}
            height={6}
            options={REAUTH_OPTIONS}
            onSelect={(_index, option) => {
              if (option?.value === "yes") void startOAuth(state.provider);
              else if (option?.value === "no") {
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
              <text>{TUI_STYLE.success("✓ API key detected in credential store.")}</text>
              <text> </text>
              <text>Replace with a new key?</text>
              <text> </text>
              <select
                id="setup-key-replace"
                focused
                width={40}
                height={6}
                options={YES_NO_OPTIONS}
                onSelect={(_index, option) => {
                  if (option?.value === "yes") enterKeyInput();
                  else if (option?.value === "no") {
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
              <select
                id="setup-env-key"
                focused
                width={40}
                height={6}
                options={YES_NO_OPTIONS}
                onSelect={(_index, option) => {
                  if (option?.value === "yes") {
                    state.keySaved = adoptEnvKeyForProvider(state.provider);
                    setStep("fetch-models");
                  } else if (option?.value === "no") enterKeyInput();
                }}
              />
            </>
          ) : (
            <>
              <text>
                {"Paste your API key.\n" +
                  TUI_STYLE.faint("  Stored in ~/.praana/credentials.json (0600).")}
              </text>
              <MaskedInput id="setup-key-input" focused onSubmit={submitKey} />
            </>
          )}
        </>
      )}

      {step() === "key-input" && (
        <>
          <text>{`Selected: ${state.provider}`}</text>
          <text> </text>
          <text>
            {[
              "Paste your API key.",
              TUI_STYLE.faint("  Stored in ~/.praana/credentials.json (0600)."),
              ...(message() ? ["", TUI_STYLE.error(`✗ ${message()}`)] : []),
              "",
            ].join("\n")}
          </text>
          <MaskedInput id="setup-key-input" focused onSubmit={submitKey} />
        </>
      )}

      {step() === "bedrock-key" && (
        <>
          <text>Selected: amazon-bedrock</text>
          <text> </text>
          <text>
            {[
              "Paste your Bedrock API key (bearer token).",
              TUI_STYLE.faint("  Or set AWS credentials / AWS_BEARER_TOKEN_BEDROCK."),
              TUI_STYLE.faint("  Stored in ~/.praana/credentials.json (0600)."),
              ...(message() ? ["", TUI_STYLE.error(`✗ ${message()}`)] : []),
              "",
            ].join("\n")}
          </text>
          <MaskedInput
            id="setup-bedrock-key-input"
            focused
            onSubmit={(value) => {
              if (!value.trim()) {
                setMessage("Bedrock API key is required when AWS credentials are not detected");
                return;
              }
              saveProviderKey("amazon-bedrock", value);
              state.keySaved = true;
              setStep("fetch-models");
            }}
          />
        </>
      )}

      {step() === "custom-id" && (
        <>
          <text>Custom OpenAI-compatible endpoint</text>
          <text> </text>
          <text>
            {[
              "Enter a provider id (lowercase, no spaces).",
              TUI_STYLE.faint("  e.g. my-llama, vllm-local, lm-studio"),
              ...(message() ? ["", TUI_STYLE.error(`✗ ${message()}`)] : []),
              "",
            ].join("\n")}
          </text>
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
          <text>
            {[
              "Enter the base URL.",
              TUI_STYLE.faint("  e.g. http://localhost:8080/v1, https://api.together.xyz/v1"),
              ...(message() ? ["", TUI_STYLE.error(`✗ ${message()}`)] : []),
              "",
            ].join("\n")}
          </text>
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
          <text>
            {"Enter API key (or press Enter to skip for keyless servers).\n" +
              TUI_STYLE.faint("  Stored in ~/.praana/credentials.json (0600).")}
          </text>
          <MaskedInput
            id="setup-custom-key"
            focused
            onSubmit={(value) => {
              if (value.trim()) {
                state.apiKey = value.trim();
                saveProviderKey(state.customProviderId, state.apiKey);
                state.keySaved = true;
              } else {
                state.keySaved = false;
              }
              setStep("fetch-models");
            }}
          />
        </>
      )}

      {step() === "fetch-models" && (
        <>
          <text>Fetching models…</text>
          <text> </text>
          <text>{TUI_STYLE.faint(`  Contacting ${providerForConfig()}…`)}</text>
        </>
      )}

      {step() === "model-picker" && (
        <>
          <text>{`Pick a default model for ${providerForConfig()}`}</text>
          <text> </text>
          <select
            id="setup-model-picker"
            focused
            width={40}
            height={maxVisible}
            options={modelOptions()}
            showScrollIndicator
            onSelect={(_index, option) => {
              state.model = typeof option?.value === "string" ? option.value : "";
              setStep("confirm");
            }}
          />
        </>
      )}

      {step() === "manual-model" && (
        <>
          <text>{`Enter model id for ${providerForConfig()}`}</text>
          <text> </text>
          <text>
            {"Enter the model id to use as default.\n" +
              (pickDefaultModel(providerForConfig())
                ? TUI_STYLE.faint(
                    `  Press Enter for default: ${pickDefaultModel(providerForConfig())}`,
                  )
                : TUI_STYLE.faint("  e.g. llama-3.1-8b-instruct"))}
          </text>
          <TextInput
            id="setup-custom-model"
            focused
            value={pickDefaultModel(providerForConfig())}
            onSubmit={(value) => {
              state.model = value.trim() || pickDefaultModel(providerForConfig()) || "";
              setStep("confirm");
            }}
          />
        </>
      )}

      {step() === "confirm" && (
        <>
          <text>{`Selected: ${providerForConfig()}`}</text>
          <text> </text>
          <text>
            {[
              `Provider: ${TUI_STYLE.success(providerForConfig())}`,
              state.model ? `Model: ${state.model}` : "Model: (auto-detect)",
              state.keySaved
                ? `Key: ${TUI_STYLE.success("saved to credential store")}`
                : hasApiKey(providerForConfig())
                  ? `Key: ${TUI_STYLE.success("in credential store")}`
                  : "Key: (not set)",
              "",
              "Create ~/.praana/config.toml?",
            ].join("\n")}
          </text>
          <text> </text>
          <select
            id="setup-confirm"
            focused
            width={40}
            height={6}
            options={YES_NO_OPTIONS}
            onSelect={(_index, option) => {
              if (option?.value === "no") finalize("skip");
              else if (option?.value === "yes") {
                if (existsSync(getSetupConfigPath())) setStep("overwrite");
                else finalize("write");
              }
            }}
          />
        </>
      )}

      {step() === "overwrite" && (
        <>
          <text>{`Config exists at ${getSetupConfigPath()}`}</text>
          <text> </text>
          <text>Overwrite?</text>
          <text> </text>
          <select
            id="setup-overwrite"
            focused
            width={40}
            height={6}
            options={YES_NO_OPTIONS}
            onSelect={(_index, option) => finalize(option?.value === "yes" ? "overwrite" : "skip")}
          />
        </>
      )}

      {step() === "oauth-status" && (
        <>
          <text>{`OAuth: ${state.provider}`}</text>
          <text> </text>
          <text>{message()}</text>
          <text>{TUI_STYLE.faint("Esc to cancel")}</text>
        </>
      )}

      {step() === "oauth-text" && (
        <>
          <text>{`OAuth: ${state.provider}`}</text>
          <text> </text>
          <text>{[...oauthContext(), oauthPrompt()].filter(Boolean).join("\n\n")}</text>
          <text> </text>
          <TextInput
            id="setup-oauth-input"
            focused
            onSubmit={(value) => {
              if (value.trim()) resolveOAuthText?.(value.trim());
            }}
          />
          <text>{TUI_STYLE.faint("Paste · Enter · Esc cancel")}</text>
        </>
      )}

      {step() === "oauth-select" && (
        <>
          <text>{`OAuth: ${state.provider}`}</text>
          <text> </text>
          <text>{oauthPrompt()}</text>
          <text> </text>
          <select
            id="setup-oauth-select"
            focused
            width={40}
            height={Math.min(8, oauthOptions().length + 1)}
            options={oauthOptions().map((option) => ({
              name: option.label,
              description: option.description ?? "",
              value: option.id,
            }))}
            onSelect={(_index, option) => {
              resolveOAuthSelect?.(typeof option?.value === "string" ? option.value : undefined);
            }}
          />
        </>
      )}

      {step() === "oauth-error" && (
        <>
          <text>{`OAuth: ${state.provider}`}</text>
          <text> </text>
          <text>{message()}</text>
          <text> </text>
          <select
            id="setup-oauth-back"
            focused
            width={40}
            height={4}
            options={[{ name: "Back to provider list", description: "", value: "back" }]}
            onSelect={() => setStep("provider")}
          />
        </>
      )}
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
      void render(() => <SetupWizard onDone={resolve} />, renderer);
    });
  } finally {
    renderer.destroy();
  }
}

function createMockStdin(chunks: string[]): NodeJS.ReadStream {
  return Readable.from(chunks) as unknown as NodeJS.ReadStream;
}
