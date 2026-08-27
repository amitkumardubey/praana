/**
 * Solid in-session login overlay.
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { InputRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  buildProviderSelectItems,
  CUSTOM_PROVIDER_VALUE,
  providerHintMatchesList,
  resolveProviderHint,
} from "../../../setup/provider-options.js";
import {
  bedrockNeedsApiKeyPrompt,
  fetchProviderModels,
  fetchCustomProviderModels,
  isValidBaseUrl,
  isValidCustomProviderId,
  pickDefaultModel,
  providerRequiresApiKey,
  providerSupportsOAuth,
  saveProviderKey,
  verifyProviderKey,
  resolvePreferredModel,
} from "../../../setup/logic.js";
import { hasApiKey } from "../../../llm.js";
import { hasCredentials, hasOAuthToken } from "../../../credentials.js";
import { isOAuthOnlyProvider } from "../../../oauth.js";
import { runOAuthLoginWithUi } from "../oauth-login-ui.js";
import {
  isUserDeclaredProvider,
  listUserDeclaredProviderIds,
  upsertUserProvider,
} from "../../../provider-registry.js";
import {
  appendProviderSection,
  updateLlmProvider,
} from "../../../setup/config-writer.js";
import type { CustomProviderConfig } from "../../../setup/types.js";
import { loadUserSettings } from "../../../user-settings.js";
import { TUI_STYLE } from "../theme.js";
import { OverlayFrame } from "./frame.js";
import { PaletteList } from "./picker.js";
import { toPaletteOptions } from "./picker-items.js";

export interface LoginWizardResult {
  provider: string;
  message: string;
  shouldSwitch: boolean;
  defaultModel: string;
}

export interface LoginOverlayProps {
  currentProvider: string;
  currentModelId?: string;
  configProvider?: string;
  configModel?: string;
  initialProvider?: string;
  onComplete: (result: LoginWizardResult) => void;
  onCancel: () => void;
}

export type LoginStep =
  | "picker"
  | "auth-method"
  | "has-key"
  | "has-oauth"
  | "key"
  | "oauth-status"
  | "oauth-text"
  | "oauth-select"
  | "oauth-error"
  | "custom-id"
  | "custom-url"
  | "custom-key"
  | "verifying"
  | "save-anyway"
  | "fetching";

export interface LoginRoutingCapabilities {
  isKnownProvider?: boolean;
  isUserDeclaredProvider?: boolean;
  hasApiKey: boolean;
  hasCredentials: boolean;
  hasOAuthToken: boolean;
  providerRequiresApiKey: boolean;
  providerSupportsOAuth: boolean;
  isOAuthOnlyProvider: boolean;
  bedrockNeedsApiKeyPrompt: boolean;
}

export function routeAfterLoginProviderChoice(
  provider: string,
  capabilities: LoginRoutingCapabilities,
): LoginStep {
  if (capabilities.providerSupportsOAuth) {
    if (capabilities.isOAuthOnlyProvider) {
      return capabilities.hasCredentials ? "has-oauth" : "oauth-status";
    }
    if (capabilities.hasCredentials) {
      return capabilities.hasOAuthToken ? "has-oauth" : "has-key";
    }
    return "auth-method";
  }
  if (capabilities.providerRequiresApiKey) {
    return capabilities.hasApiKey ? "has-key" : "key";
  }
  if (provider === "amazon-bedrock") {
    return capabilities.bedrockNeedsApiKeyPrompt ? "key" : "fetching";
  }
  return "fetching";
}

export function routeLoginHint(
  hint: string,
  capabilities: LoginRoutingCapabilities,
): { step: LoginStep; provider?: string; customId?: string } {
  if (capabilities.isKnownProvider && !capabilities.isUserDeclaredProvider) {
    return {
      provider: hint,
      step: routeAfterLoginProviderChoice(hint, capabilities),
    };
  }
  if (capabilities.isUserDeclaredProvider) {
    return { provider: hint, step: capabilities.hasApiKey ? "has-key" : "key" };
  }
  return { customId: hint, step: "custom-url" };
}

const YES_NO_OPTIONS = [
  { value: "yes", name: "Yes — enter a new key", description: "" },
  { value: "no", name: "No — use existing key", description: "" },
];

const REAUTH_OPTIONS = [
  { value: "yes", name: "Yes — sign in again", description: "" },
  { value: "no", name: "No — use existing credentials", description: "" },
];

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
        actual = displayed.length >= previousDisplay.length
          ? actual + displayed.slice(previousDisplay.length)
          : actual.slice(0, displayed.length);
        if (input) input.value = "•".repeat(actual.length);
      }}
      onSubmit={() => props.onSubmit(actual)}
    />
  );
}

function TextInput(props: {
  id: string;
  focused?: boolean;
  onSubmit: (value: string) => void;
}) {
  let input: InputRenderable | undefined;
  return (
    <input
      id={props.id}
      focused={props.focused}
      ref={(element: InputRenderable) => {
        input = element;
      }}
      onSubmit={() => props.onSubmit(input?.value ?? "")}
    />
  );
}

function providerCapabilities(provider: string): LoginRoutingCapabilities {
  return {
    isKnownProvider: provider in providerMap(),
    isUserDeclaredProvider: isUserDeclaredProvider(provider),
    hasApiKey: hasApiKey(provider),
    hasCredentials: hasCredentials(provider),
    hasOAuthToken: hasOAuthToken(provider),
    providerRequiresApiKey: providerRequiresApiKey(provider),
    providerSupportsOAuth: providerSupportsOAuth(provider),
    isOAuthOnlyProvider: isOAuthOnlyProvider(provider),
    bedrockNeedsApiKeyPrompt: bedrockNeedsApiKeyPrompt(),
  };
}

function providerMap(): Record<string, true> {
  return Object.fromEntries(
    buildProviderSelectItems()
      .filter((item) => item.value !== CUSTOM_PROVIDER_VALUE)
      .map((item) => [item.value, true]),
  );
}

export function LoginOverlay(props: LoginOverlayProps) {
  const renderer = useRenderer();
  const rawHint = props.initialProvider?.toLowerCase().trim();
  const providerItems = buildProviderSelectItems();
  const resolvedHint = rawHint
    ? resolveProviderHint(
        rawHint,
        providerItems.map((item) => item.value),
      )
    : undefined;
  const pickerQuery =
    rawHint && !resolvedHint && providerHintMatchesList(rawHint, providerItems)
      ? rawHint
      : "";
  const hint = resolvedHint ?? (pickerQuery ? undefined : rawHint);
  const routed = hint ? routeLoginHint(hint, providerCapabilities(hint)) : undefined;
  const [step, setStep] = createSignal<LoginStep>(routed?.step ?? "picker");
  const [message, setMessage] = createSignal("");
  const [oauthPrompt, setOauthPrompt] = createSignal("");
  const [oauthPlaceholder, setOauthPlaceholder] = createSignal("");
  const [oauthContext, setOauthContext] = createSignal<string[]>([]);
  const [oauthOptions, setOauthOptions] = createSignal<
    readonly { id: string; label: string; description?: string }[]
  >([]);
  let provider = routed?.provider ?? "";
  let customId = routed?.customId ?? "";
  let customBaseUrl = "";
  let oauthAbort: AbortController | undefined;
  let rejectOAuthText: ((error: Error) => void) | undefined;
  let resolveOAuthSelect: ((value: string | undefined) => void) | undefined;
  let settled = false;

  onMount(() => {
    if (step() === "oauth-status") void startOAuth();
    if (step() === "fetching") void finishKeyless();
  });

  onCleanup(() => {
    oauthAbort?.abort();
    rejectOAuthText?.(new Error("cancelled"));
    resolveOAuthSelect?.(undefined);
  });

  const complete = (result: LoginWizardResult) => {
    if (settled) return;
    settled = true;
    props.onComplete(result);
  };

  const preferredModel = (providerId: string, liveModels?: Parameters<typeof pickDefaultModel>[1]) => {
    const settings = loadUserSettings().settings;
    return resolvePreferredModel(providerId, {
      currentProvider: props.currentProvider,
      currentModel: props.currentModelId,
      configProvider: props.configProvider,
      configModel: props.configModel,
      settingsProvider: settings.provider,
      settingsModel: settings.model,
      liveModels,
    });
  };

  const finishKeyless = async () => {
    setStep("fetching");
    const liveModels = await fetchProviderModels(provider);
    complete({
      provider,
      message: `${provider} doesn't require an API key.`,
      shouldSwitch: true,
      defaultModel: preferredModel(provider, liveModels),
    });
  };

  const commitKey = async (keySaved: boolean, keyValue: string) => {
    const isCustom = isUserDeclaredProvider(provider);
    if (keySaved && keyValue) saveProviderKey(provider, keyValue);
    const usedOAuth = hasOAuthToken(provider) && !keySaved;
    if (isCustom) {
      setStep("fetching");
      const liveModels = await fetchProviderModels(provider);
      const defaultModel = preferredModel(provider, liveModels);
      complete({
        provider,
        message: keySaved
          ? `Key saved for ${provider}. Switched to ${provider}.`
          : `Using existing key for ${provider}.`,
        shouldSwitch: true,
        defaultModel,
      });
      return;
    }
    setStep("fetching");
    const liveModels = await fetchProviderModels(provider);
    const defaultModel = preferredModel(provider, liveModels);
    if (defaultModel) updateLlmProvider(provider, defaultModel);
    else updateLlmProvider(provider);
    complete({
      provider,
      message: keySaved
        ? `Key saved. Switched to ${provider}.`
        : usedOAuth
          ? `Signed in via OAuth. Switched to ${provider}.`
          : `Switched to ${provider}.`,
      shouldSwitch: true,
      defaultModel,
    });
  };

  let pendingVerifyKey = "";
  let verifyingCustom = false;

  const finish = async (keySaved: boolean, keyValue: string) => {
    verifyingCustom = false;
    if (!keySaved || !keyValue) {
      await commitKey(false, "");
      return;
    }
    setStep("verifying");
    setMessage("Verifying key…");
    const result = await verifyProviderKey(provider, keyValue);
    if (result.status === "unauthorized") {
      setMessage(result.message);
      setStep("key");
      return;
    }
    if (result.status === "unreachable") {
      pendingVerifyKey = keyValue;
      setMessage(result.message);
      setStep("save-anyway");
      return;
    }
    await commitKey(true, keyValue);
  };

  const finishCustom = async (keyValue: string) => {
    verifyingCustom = true;
    if (keyValue) {
      setStep("verifying");
      setMessage("Verifying key…");
      const verified = await verifyProviderKey(customId, keyValue, { baseUrl: customBaseUrl });
      if (verified.status === "unauthorized") {
        setMessage(verified.message);
        setStep("custom-key");
        return;
      }
      if (verified.status === "unreachable") {
        pendingVerifyKey = keyValue;
        setMessage(verified.message);
        setStep("save-anyway");
        return;
      }
    }
    await commitCustom(keyValue);
  };

  const commitCustom = async (keyValue: string) => {
    const config: CustomProviderConfig = {
      id: customId,
      api: "openai-completions",
      baseUrl: customBaseUrl,
      envKey: keyValue ? `${customId.toUpperCase().replace(/-/g, "_")}_API_KEY` : undefined,
    };
    if (keyValue) saveProviderKey(customId, keyValue);
    upsertUserProvider(customId, {
      api: config.api,
      base_url: config.baseUrl,
      env_key: config.envKey,
    });
    const writeResult = appendProviderSection(config);
    setStep("fetching");
    const live = await fetchCustomProviderModels(customBaseUrl, keyValue || undefined);
    const defaultModel = live?.[0]?.id ?? "";
    if (defaultModel) updateLlmProvider(customId, defaultModel);
    complete({
      provider: customId,
      message: writeResult.written
        ? `Provider ${customId} saved. Switched to ${customId}.`
        : writeResult.message,
      shouldSwitch: true,
      defaultModel,
    });
  };

  const routeProvider = (selected: string) => {
    provider = selected;
    const next = routeAfterLoginProviderChoice(selected, providerCapabilities(selected));
    if (next === "fetching") void finishKeyless();
    else if (next === "oauth-status") void startOAuth();
    else setStep(next);
  };

  const selectProvider = (value: string) => {
    setMessage("");
    if (value === CUSTOM_PROVIDER_VALUE) {
      setStep("custom-id");
    } else if (isUserDeclaredProvider(value)) {
      provider = value;
      setStep(hasApiKey(value) ? "has-key" : "key");
    } else {
      routeProvider(value);
    }
  };

  const startOAuth = async () => {
    const abort = new AbortController();
    oauthAbort?.abort();
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
            rejectOAuthText = reject;
            abort.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            });
            setOauthPrompt(prompt);
            setOauthPlaceholder(placeholder ?? "");
            setOauthContext(contextLines ?? []);
            setStep("oauth-text");
            const submit = (value: string) => {
              if (!value.trim()) return;
              rejectOAuthText = undefined;
              resolve(value.trim());
            };
            oauthTextSubmit = submit;
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
      if (!abort.signal.aborted) await finish(false, "");
    } catch (error) {
      if (!abort.signal.aborted) {
        setMessage(`OAuth failed: ${error instanceof Error ? error.message : String(error)}`);
        setStep("oauth-error");
      }
    } finally {
      if (oauthAbort === abort) oauthAbort = undefined;
      rejectOAuthText = undefined;
      resolveOAuthSelect = undefined;
      oauthTextSubmit = undefined;
    }
  };

  let oauthTextSubmit: ((value: string) => void) | undefined;
  const pickerOptions = () => {
    const items = buildProviderSelectItems();
    for (const id of listUserDeclaredProviderIds()) {
      if (!items.some((item) => item.value === id)) {
        items.push({ value: id, label: id, description: "(custom)" });
      }
    }
    return toPaletteOptions(items);
  };

  return (
    <OverlayFrame width={64}>
      {step() === "picker" && (
        <>
          <text><span style={TUI_STYLE.info}>{"Login — select a provider"}</span></text>
          <PaletteList
            options={pickerOptions()}
            placeholder="search providers…"
            initialQuery={pickerQuery}
            onSelect={(value) => selectProvider(value)}
          />
        </>
      )}
      {step() === "auth-method" && (
        <>
          <text><span style={TUI_STYLE.info}>{`How do you want to authenticate ${provider}?`}</span></text>
          <PaletteList
            options={provider === "anthropic"
              ? [
                  { value: "oauth", name: "Claude Pro/Max OAuth", description: "Browser sign-in" },
                  { value: "api_key", name: "API key", description: "Paste ANTHROPIC_API_KEY" },
                ]
              : [
                  { value: "oauth", name: "OAuth / subscription", description: "Browser sign-in" },
                  { value: "api_key", name: "API key", description: "Paste a static key" },
                ]}
            onSelect={(value) => {
              if (value === "oauth") void startOAuth();
              else if (value === "api_key") setStep("key");
            }}
          />
        </>
      )}
      {step() === "has-key" && (
        <>
          <text><span style={TUI_STYLE.info}>{`You already have a key for ${provider}.`}</span></text>
          <PaletteList
            options={YES_NO_OPTIONS}
            onSelect={(value) => {
              if (value === "yes") setStep("key");
              else if (value === "no") void finish(false, "");
            }}
          />
        </>
      )}
      {step() === "has-oauth" && (
        <>
          <text><span style={TUI_STYLE.info}>{`You already have OAuth credentials for ${provider}.`}</span></text>
          <PaletteList
            options={REAUTH_OPTIONS}
            onSelect={(value) => {
              if (value === "yes") {
                setStep(providerSupportsOAuth(provider) && !isOAuthOnlyProvider(provider)
                  ? "auth-method"
                  : "oauth-status");
                if (isOAuthOnlyProvider(provider)) void startOAuth();
              } else if (value === "no") void finish(false, "");
            }}
          />
        </>
      )}
      {step() === "key" && (
        <>
          <text><span style={TUI_STYLE.info}>{provider === "amazon-bedrock"
            ? "Paste your Bedrock API key (bearer token)"
            : `Enter API key for ${provider}`}</span></text>
          <text><span style={TUI_STYLE.muted}>{provider === "amazon-bedrock"
            ? "Or set AWS credentials / AWS_BEARER_TOKEN_BEDROCK. Saved to ~/.praana/credentials.json (0o600)"
            : "Saved to ~/.praana/credentials.json (0o600)"}</span></text>
          <MaskedInput
            id="login-key-input"
            focused
            onSubmit={(value) => {
              const key = value.trim();
              if (key) void finish(true, key);
              else if (isUserDeclaredProvider(provider)) void finish(false, "");
              else setMessage("Key cannot be empty. Press Esc to cancel.");
            }}
          />
          {message() && <text><span style={TUI_STYLE.error}>{message()}</span></text>}
        </>
      )}
      {step() === "custom-id" && (
        <>
          <text><span style={TUI_STYLE.info}>{"Custom OpenAI-compatible provider"}</span></text>
          <text><span style={TUI_STYLE.muted}>{"Enter a provider id (lowercase, e.g. my-llama):"}</span></text>
          <TextInput
            id="login-custom-id"
            focused
            onSubmit={(value) => {
              const validation = isValidCustomProviderId(value.trim());
              if (!validation.valid) setMessage(`Invalid: ${validation.error}`);
              else {
                customId = value.trim();
                setMessage("");
                setStep("custom-url");
              }
            }}
          />
          {message() && <text><span style={TUI_STYLE.error}>{message()}</span></text>}
        </>
      )}
      {step() === "custom-url" && (
        <>
          <text><span style={TUI_STYLE.info}>{`Configure ${customId}`}</span></text>
          <text><span style={TUI_STYLE.muted}>{"Base URL (e.g. http://localhost:8080/v1):"}</span></text>
          <TextInput
            id="login-custom-url"
            focused
            onSubmit={(value) => {
              const validation = isValidBaseUrl(value.trim());
              if (!validation.valid) setMessage(`Invalid: ${validation.error}`);
              else {
                customBaseUrl = value.trim();
                setMessage("");
                setStep("custom-key");
              }
            }}
          />
          {message() && <text><span style={TUI_STYLE.error}>{message()}</span></text>}
        </>
      )}
      {step() === "custom-key" && (
        <>
          <text><span style={TUI_STYLE.info}>{`API key for ${customId}`}</span></text>
          <text><span style={TUI_STYLE.muted}>{"Press Enter to skip for keyless local servers"}</span></text>
          <MaskedInput id="login-custom-key" focused onSubmit={(value) => void finishCustom(value.trim())} />
        </>
      )}
      {step() === "verifying" && <text><span style={TUI_STYLE.info}>{message() || "Verifying key…"}</span></text>}
      {step() === "save-anyway" && (
        <>
          <text><span style={TUI_STYLE.error}>{message()}</span></text>
          <text><span style={TUI_STYLE.muted}>Save anyway and continue?</span></text>
          <PaletteList
            options={[
              { value: "yes", name: "Yes — save anyway", description: "" },
              { value: "no", name: "No — re-enter key", description: "" },
            ]}
            onSelect={(value) => {
              if (value === "yes") {
                if (verifyingCustom) void commitCustom(pendingVerifyKey);
                else void commitKey(true, pendingVerifyKey);
              } else if (value === "no") {
                setMessage("");
                setStep(verifyingCustom ? "custom-key" : "key");
              }
            }}
          />
        </>
      )}
      {step() === "fetching" && <text><span style={TUI_STYLE.info}>{"Fetching models…"}</span></text>}
      {step() === "oauth-status" && (
        <>
          <text><span style={TUI_STYLE.info}>{`OAuth: ${provider}`}</span></text>
          <text>{message()}</text>
          <text><span style={TUI_STYLE.faint}>{"Esc to cancel"}</span></text>
        </>
      )}
      {step() === "oauth-text" && (
        <>
          <text><span style={TUI_STYLE.info}>{`OAuth: ${provider}`}</span></text>
          <text>{[...oauthContext(), oauthPrompt()].filter(Boolean).join("\n\n")}</text>
          <Show when={oauthPlaceholder()}>
            <text><span style={TUI_STYLE.muted}>{oauthPlaceholder()}</span></text>
          </Show>
          <TextInput id="login-oauth-input" focused onSubmit={(value) => oauthTextSubmit?.(value)} />
          <text><span style={TUI_STYLE.faint}>{"Paste · Enter · Esc cancel"}</span></text>
        </>
      )}
      {step() === "oauth-select" && (
        <>
          <text><span style={TUI_STYLE.info}>{`OAuth: ${provider}`}</span></text>
          <text>{oauthPrompt()}</text>
          <PaletteList
            options={oauthOptions().map((option) => ({
              name: option.label,
              description: option.description ?? "",
              value: option.id,
            }))}
            onSelect={(value) => resolveOAuthSelect?.(value)}
          />
        </>
      )}
      {step() === "oauth-error" && (
        <>
          <text><span style={TUI_STYLE.error}>{message()}</span></text>
          <PaletteList
            options={[{ name: "Back to provider list", description: "", value: "back" }]}
            onSelect={() => setStep("picker")}
          />
        </>
      )}
    </OverlayFrame>
  );
}
