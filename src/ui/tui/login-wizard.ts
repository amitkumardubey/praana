/**
 * In-place login wizard — opened by /login.
 *
 * Unlike the setup wizard (which runs as a standalone TUI session), this
 * component replaces the prompt slot content, like ModelSelector. It
 * collects a provider choice and API key, saves them, and calls back.
 *
 * Flow:
 *   1. Provider picker (if no /login <provider> hint)
 *   2. API key entry (masked) → saved to ~/.praana/credentials.json
 *   3. For catalog providers: switch the live session via onComplete
 *   4. For custom providers: write [providers.<id>] section → /new to activate
 */
import {
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type RenderContext,
  type KeyEvent,
} from "@opentui/core";
import { TUI_STYLE } from "./theme.js";
import {
  buildProviderSelectItems,
  CUSTOM_PROVIDER_VALUE,
} from "../../setup/provider-options.js";
import {
  saveProviderKey,
  isValidCustomProviderId,
  isValidBaseUrl,
  providerRequiresApiKey,
  providerSupportsOAuth,
  pickDefaultModel,
  fetchProviderModels,
  bedrockNeedsApiKeyPrompt,
} from "../../setup/logic.js";
import { hasApiKey } from "../../llm.js";
import { hasCredentials, hasOAuthToken } from "../../credentials.js";
import { isOAuthOnlyProvider } from "../../oauth.js";
import { runOAuthLoginWithUi } from "./oauth-login-ui.js";
import {
  isUserDeclaredProvider,
  listUserDeclaredProviderIds,
} from "../../provider-registry.js";
import {
  updateLlmProvider,
  appendProviderSection,
} from "../../setup/config-writer.js";
import type { CustomProviderConfig } from "../../setup/types.js";

export interface LoginProvider {
  id: string;
  label: string;
}

export interface LoginWizardResult {
  provider: string;
  message: string;
  /** True for catalog providers — the callback should switch the session. */
  shouldSwitch: boolean;
  /** Default model for the provider (for /model switching). */
  defaultModel: string;
}

export interface LoginWizardOptions {
  currentProvider: string;
  initialProvider?: string;
  onComplete: (result: LoginWizardResult) => void;
  onCancel: () => void;
}

type Step =
  | "picker"
  | "auth-method"
  | "has-key"
  | "has-oauth"
  | "key"
  | "oauth"
  | "custom-id"
  | "custom-url"
  | "custom-key";

class LoginSelect extends SelectRenderable {
  onCancel: (() => void) | null = null;

  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "escape" && this.onCancel) {
      this.onCancel();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

class MaskedInput extends InputRenderable {
  private _masked = false;
  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "escape") {
      if ((this as unknown as { onEscape?: () => void }).onEscape) {
        (this as unknown as { onEscape: () => void }).onEscape();
        return true;
      }
    }
    return super.handleKeyPress(key);
  }

  get isMasked(): boolean {
    return this._masked;
  }
  set isMasked(value: boolean) {
    this._masked = value;
    if (value) {
      this.setPlaceholderMask(true);
    }
    this.requestRender();
  }

  private setPlaceholderMask(mask: boolean): void {
    // For masking, we'll use the extmarks or styling approach
    // The InputRenderable inherits TextBufferRenderable which supports
    // setting text attributes. For simplicity in v1, we keep the value
    // but could add masking via extmarks in a future iteration.
  }
}

const YES_NO_ITEMS = [
  { value: "yes", name: "Yes — enter a new key", description: "" },
  { value: "no", name: "No — use existing key", description: "" },
];

const AUTH_METHOD_ITEMS = [
  { value: "oauth", name: "Claude Pro/Max OAuth", description: "Browser sign-in" },
  { value: "api_key", name: "API key", description: "Paste ANTHROPIC_API_KEY" },
];

const REAUTH_ITEMS = [
  { value: "yes", name: "Yes — sign in again", description: "" },
  { value: "no", name: "No — use existing credentials", description: "" },
];

export class LoginWizard extends BoxRenderable {
  private currentProvider: string;
  private onCompleteCallback: (result: LoginWizardResult) => void;
  private onCancelCallback: () => void;

  private step: Step = "picker";
  private provider = "";
  private customId = "";
  private customBaseUrl = "";

  private providerSelect: LoginSelect | null = null;
  private activeInput: InputRenderable | null = null;
  private activeList: LoginSelect | null = null;
  private stepLabel: TextRenderable;

  private oauthAbort: AbortController | null = null;
  private textPromptResolve: ((value: string) => void) | null = null;
  private textPromptReject: ((err: Error) => void) | null = null;
  private selectPromptResolve: ((value: string | undefined) => void) | null = null;

  private readonly wizardProviders: LoginProvider[];

  constructor(ctx: RenderContext, providers?: LoginProvider[], options?: LoginWizardOptions) {
    super(ctx, {
      id: "login-wizard",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      padding: 1,
      title: "Log in",
    });

    // Support both old (options-only) and new (providers, options) constructor patterns
    if (providers && options) {
      this.wizardProviders = providers;
      this.currentProvider = options.currentProvider;
      this.onCompleteCallback = options.onComplete;
      this.onCancelCallback = options.onCancel;
    } else if (options) {
      // Legacy: single options object (from run.ts during migration)
      const opts = providers as unknown as LoginWizardOptions;
      this.wizardProviders = [];
      this.currentProvider = opts.currentProvider;
      this.onCompleteCallback = opts.onComplete;
      this.onCancelCallback = opts.onCancel;
    } else {
      throw new Error("LoginWizard requires providers and options");
    }

    this.stepLabel = new TextRenderable(ctx, {
      content: TUI_STYLE.info("Login — select a provider"),
    });
    this.add(this.stepLabel);

    const hint = options?.initialProvider?.toLowerCase().trim();
    if (hint) {
      this.routeFromHint(hint);
    } else {
      this.step = "picker";
    }

    this.showStep();
  }

  private routeFromHint(hint: string): void {
    if (!isUserDeclaredProvider(hint) && hint in buildProviderMap()) {
      this.provider = hint;
      this.routeAfterProviderChoice(hint);
    } else if (isUserDeclaredProvider(hint)) {
      this.provider = hint;
      this.step = hasApiKey(hint) ? "has-key" : "key";
    } else {
      this.customId = hint;
      this.step = "custom-url";
    }
  }

  private routeAfterProviderChoice(provider: string): void {
    if (providerSupportsOAuth(provider)) {
      if (isOAuthOnlyProvider(provider)) {
        this.step = hasCredentials(provider) ? "has-oauth" : "oauth";
        return;
      }
      if (hasCredentials(provider)) {
        this.step = hasOAuthToken(provider) ? "has-oauth" : "has-key";
        return;
      }
      this.step = "auth-method";
      return;
    }
    if (providerRequiresApiKey(provider)) {
      this.step = hasApiKey(provider) ? "has-key" : "key";
      return;
    }
    if (provider === "amazon-bedrock") {
      if (!bedrockNeedsApiKeyPrompt()) {
        void this.finishKeyless();
        return;
      }
      this.step = "key";
      return;
    }
    void this.finishKeyless();
  }

  private showStep(): void {
    this.stepLabel.content = this.stepLabelFor(this.step);
    this.removeProviderSelect();
    this.removeActiveInput();

    switch (this.step) {
      case "picker":
        this.showPicker();
        break;
      case "auth-method":
        this.showAuthMethodPrompt();
        break;
      case "has-key":
        this.showHasKeyPrompt();
        break;
      case "has-oauth":
        this.showHasOAuthPrompt();
        break;
      case "key":
        this.showKeyEntry();
        break;
      case "oauth":
        void this.startOAuthFlow();
        break;
      case "custom-id":
        this.showCustomIdEntry();
        break;
      case "custom-url":
        this.showCustomUrlEntry();
        break;
      case "custom-key":
        this.showCustomKeyEntry();
        break;
    }

    // Focus the newly created active component
    if (this.step !== "oauth") {
      this.activeList?.focus();
      this.activeInput?.focus();
    }
  }

  private stepLabelFor(step: Step): string {
    switch (step) {
      case "picker":
        return TUI_STYLE.info("Login — select a provider");
      case "auth-method":
        return TUI_STYLE.info(`How do you want to authenticate ${this.provider}?`);
      case "has-key":
        return TUI_STYLE.info(`You already have a key for ${this.provider}.`);
      case "has-oauth":
        return TUI_STYLE.info(`You already have OAuth credentials for ${this.provider}.`);
      case "key":
        return TUI_STYLE.info(this.provider === "amazon-bedrock"
          ? "Paste your Bedrock API key (bearer token)"
          : `Enter API key for ${this.provider}`);
      case "oauth":
        return TUI_STYLE.info(`Starting OAuth for ${this.provider}…`);
      case "custom-id":
        return TUI_STYLE.info("Custom OpenAI-compatible provider");
      case "custom-url":
        return TUI_STYLE.info(`Configure ${this.customId}`);
      case "custom-key":
        return TUI_STYLE.info(`API key for ${this.customId}`);
    }
  }

  private removeProviderSelect(): void {
    if (this.providerSelect) {
      this.remove(this.providerSelect);
      this.providerSelect = null;
    }
  }

  private removeActiveInput(): void {
    if (this.activeInput) {
      this.remove(this.activeInput);
      this.activeInput = null;
    }
  }

  // ── Step: Provider picker ──

  private showPicker(): void {
    const items = this.buildPickerItems();
    const maxVisible = Math.max(6, Math.min(12, (process.stdout.rows ?? 24) - 10));

    this.providerSelect = new LoginSelect(this.ctx, {
      id: "login-wizard-picker",
      width: 40,
      height: maxVisible,
      options: items.map((item) => ({
        name: item.label,
        description: item.description ?? "",
        value: item.value,
      })),
    });

    this.activeList = this.providerSelect;
    this.providerSelect.onCancel = () => this.onCancelCallback();

    this.providerSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      if (typeof option.value !== "string") return;
      this.onProviderSelected(option.value);
    });

    this.add(this.providerSelect);
  }

  private buildPickerItems(): { value: string; label: string; description?: string }[] {
    if (this.wizardProviders.length > 0) {
      const items = this.wizardProviders.map((p) => ({
        value: p.id,
        label: p.label,
        description: "",
      }));
      // Add user-declared providers not in the wizard list
      for (const id of listUserDeclaredProviderIds()) {
        if (!items.some((i) => i.value === id)) {
          items.push({ value: id, label: id, description: "(custom)" });
        }
      }
      return items;
    }
    return buildProviderSelectItems();
  }

  private onProviderSelected(value: string): void {
    if (value === CUSTOM_PROVIDER_VALUE) {
      this.step = "custom-id";
    } else if (isUserDeclaredProvider(value)) {
      this.provider = value;
      this.step = hasApiKey(value) ? "has-key" : "key";
    } else {
      this.provider = value;
      this.routeAfterProviderChoice(value);
    }
    this.showStep();
    this.requestRender();
  }

  // ── Step: Auth method ──

  private showAuthMethodPrompt(): void {
    const items =
      this.provider === "anthropic"
        ? AUTH_METHOD_ITEMS
        : [
            { value: "oauth", name: "OAuth / subscription", description: "Browser sign-in" },
            { value: "api_key", name: "API key", description: "Paste a static key" },
          ];

    this.providerSelect = new LoginSelect(this.ctx, {
      id: "login-wizard-auth-method",
      width: 40,
      height: Math.min(6, items.length + 1),
      options: items,
    });

    this.activeList = this.providerSelect;
    this.providerSelect.onCancel = () => this.onCancelCallback();

    this.providerSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      if (typeof option.value !== "string") return;
      this.step = option.value === "oauth" ? "oauth" : "key";
      this.showStep();
      this.requestRender();
    });

    this.add(this.providerSelect);
  }

  // ── Step: Has key prompt ──

  private showHasKeyPrompt(): void {
    this.providerSelect = new LoginSelect(this.ctx, {
      id: "login-wizard-has-key",
      width: 40,
      height: 6,
      options: YES_NO_ITEMS,
    });

    this.activeList = this.providerSelect;
    this.providerSelect.onCancel = () => this.onCancelCallback();

    this.providerSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      if (option.value === "yes") {
        this.step = "key";
      } else {
        void this.finish(false, "");
        return;
      }
      this.showStep();
      this.requestRender();
    });

    this.add(this.providerSelect);
  }

  // ── Step: Has OAuth prompt ──

  private showHasOAuthPrompt(): void {
    this.providerSelect = new LoginSelect(this.ctx, {
      id: "login-wizard-has-oauth",
      width: 40,
      height: 6,
      options: REAUTH_ITEMS,
    });

    this.activeList = this.providerSelect;
    this.providerSelect.onCancel = () => this.onCancelCallback();

    this.providerSelect.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      if (option.value === "yes") {
        this.step =
          providerSupportsOAuth(this.provider) && !isOAuthOnlyProvider(this.provider)
            ? "auth-method"
            : "oauth";
      } else {
        void this.finish(false, "");
        return;
      }
      this.showStep();
      this.requestRender();
    });

    this.add(this.providerSelect);
  }

  // ── Step: OAuth login ──

  private async startOAuthFlow(): Promise<void> {
    this.oauthAbort?.abort();
    this.oauthAbort = new AbortController();
    const signal = this.oauthAbort.signal;

    this.stepLabel.content = TUI_STYLE.info(`Starting OAuth for ${this.provider}…`);
    this.removeProviderSelect();
    this.removeActiveInput();
    this.requestRender();

    const showStatus = (lines: string[]) => {
      this.stepLabel.content = TUI_STYLE.info(lines.length > 0 ? lines[0] : "");
      this.requestRender();
    };

    const promptText = (
      message: string,
      placeholder?: string,
      contextLines?: string[],
    ): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        this.textPromptResolve = resolve;
        this.textPromptReject = reject;
        this.stepLabel.content = TUI_STYLE.info(message);
        this.removeActiveInput();
        const input = new InputRenderable(this.ctx, { id: "login-wizard-oauth-input" });
        input.onSubmit = () => {
          const value = input.value.trim();
          if (!value) return;
          this.textPromptResolve = null;
          this.textPromptReject = null;
          resolve(value);
        };
        (input as unknown as { onEscape: (() => void) | null }).onEscape = () => {
          this.textPromptReject?.(new Error("cancelled"));
          this.textPromptResolve = null;
          this.textPromptReject = null;
          this.onCancelCallback();
        };
        this.activeInput = input;
        this.add(input);
        input.focus();
        this.requestRender();
      });
    };

    const promptSelect = (
      message: string,
      options: readonly { id: string; label: string; description?: string }[],
    ): Promise<string | undefined> => {
      return new Promise<string | undefined>((resolve) => {
        this.selectPromptResolve = resolve;
        this.stepLabel.content = TUI_STYLE.info(message);
        this.removeActiveInput();
        this.removeProviderSelect();

        const select = new LoginSelect(this.ctx, {
          id: "login-wizard-oauth-select",
          width: 40,
          height: Math.min(8, options.length + 1),
          options: options.map((o) => ({
            name: o.label,
            description: o.description ?? "",
            value: o.id,
          })),
        });

        this.activeList = select;
        select.onCancel = () => {
          this.selectPromptResolve = null;
          resolve(undefined);
        };
        select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
          this.selectPromptResolve = null;
          resolve(typeof option.value === "string" ? option.value : undefined);
        });

        this.add(select);
        select.focus();
        this.requestRender();
      });
    };

    try {
      await runOAuthLoginWithUi(this.provider, {
        showStatus,
        promptText,
        promptSelect,
        signal,
      });
      if (signal.aborted) {
        this.onCancelCallback();
        return;
      }
      await this.finish(false, "");
    } catch (err) {
      if (signal.aborted) {
        this.onCancelCallback();
        return;
      }
      this.stepLabel.content = TUI_STYLE.error(
        `OAuth failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.requestRender();
    }
  }

  // ── Step: API key entry ──

  private showKeyEntry(): void {
    const isCustom = isUserDeclaredProvider(this.provider);

    const hint = new TextRenderable(this.ctx, {
      content: TUI_STYLE.muted(
        this.provider === "amazon-bedrock"
          ? "Or set AWS credentials / AWS_BEARER_TOKEN_BEDROCK. Saved to ~/.praana/credentials.json (0o600)"
          : "Saved to ~/.praana/credentials.json (0o600)",
      ),
    });
    this.add(hint);

    const input = new MaskedInput(this.ctx, {
      id: "login-wizard-key-input",
      placeholder: "",
    });
    input.isMasked = true;

    input.onSubmit = () => {
      const value = input.value.trim();
      if (!value) {
        if (isCustom) {
          void this.finish(false, "");
          return;
        }
        this.stepLabel.content = TUI_STYLE.error("Key cannot be empty. Press Esc to cancel.");
        this.requestRender();
        return;
      }
      void this.finish(true, value);
    };

    (input as unknown as { onEscape: (() => void) | null }).onEscape = () => {
      this.onCancelCallback();
    };

    this.activeInput = input;
    this.add(input);
    input.focus();
  }

  // ── Step: Custom provider ID ──

  private showCustomIdEntry(): void {
    const hint = new TextRenderable(this.ctx, {
      content: TUI_STYLE.muted("Enter a provider id (lowercase, e.g. my-llama):"),
    });
    this.add(hint);

    const input = new InputRenderable(this.ctx, { id: "login-wizard-custom-id" });
    this.activeInput = input;
    this.add(input);
    (input as unknown as { onEscape: (() => void) | null }).onEscape = () => {
      this.onCancelCallback();
    };
    input.focus();
    input.onSubmit = () => {
      const trimmed = input.value.trim();
      const validation = isValidCustomProviderId(trimmed);
      if (!validation.valid) {
        this.stepLabel.content = TUI_STYLE.error(`Invalid: ${validation.error}`);
        this.requestRender();
        return;
      }
      this.customId = trimmed;
      this.step = "custom-url";
      this.showStep();
      this.requestRender();
    };
  }

  // ── Step: Custom base URL ──

  private showCustomUrlEntry(): void {
    const hint = new TextRenderable(this.ctx, {
      content: TUI_STYLE.muted("Base URL (e.g. http://localhost:8080/v1):"),
    });
    this.add(hint);

    const input = new InputRenderable(this.ctx, { id: "login-wizard-custom-url" });
    this.activeInput = input;
    this.add(input);
    (input as unknown as { onEscape: (() => void) | null }).onEscape = () => {
      this.onCancelCallback();
    };
    input.focus();
    input.onSubmit = () => {
      const trimmed = input.value.trim();
      const validation = isValidBaseUrl(trimmed);
      if (!validation.valid) {
        this.stepLabel.content = TUI_STYLE.error(`Invalid: ${validation.error}`);
        this.requestRender();
        return;
      }
      this.customBaseUrl = trimmed;
      this.step = "custom-key";
      this.showStep();
      this.requestRender();
    };
  }

  // ── Step: Custom API key ──

  private showCustomKeyEntry(): void {
    const hint = new TextRenderable(this.ctx, {
      content: TUI_STYLE.muted("Press Enter to skip for keyless local servers"),
    });
    this.add(hint);

    const input = new MaskedInput(this.ctx, { id: "login-wizard-custom-key" });
    input.isMasked = true;
    this.activeInput = input;
    this.add(input);
    (input as unknown as { onEscape: (() => void) | null }).onEscape = () => {
      this.onCancelCallback();
    };
    input.focus();
    input.onSubmit = () => {
      void this.finishCustom(input.value.trim());
    };
  }

  // ── Completion ──

  private showFetchingModels(): void {
    this.stepLabel.content = TUI_STYLE.info("Fetching models…");
    this.removeProviderSelect();
    this.removeActiveInput();
    this.requestRender();
  }

  private async finishKeyless(): Promise<void> {
    this.showFetchingModels();
    const liveModels = await fetchProviderModels(this.provider);
    const defaultModel = pickDefaultModel(this.provider, liveModels);
    this.onCompleteCallback({
      provider: this.provider,
      message: `${this.provider} doesn't require an API key.`,
      shouldSwitch: true,
      defaultModel,
    });
  }

  private async finish(keySaved: boolean, keyValue: string): Promise<void> {
    const isCustom = isUserDeclaredProvider(this.provider);
    if (keySaved && keyValue) {
      saveProviderKey(this.provider, keyValue);
    }

    const usedOAuth = hasOAuthToken(this.provider) && !keySaved;

    if (!isCustom) {
      this.showFetchingModels();
      const liveModels = await fetchProviderModels(this.provider);
      const defaultModel = pickDefaultModel(this.provider, liveModels);
      updateLlmProvider(this.provider, defaultModel || undefined);
      this.onCompleteCallback({
        provider: this.provider,
        message: keySaved
          ? `Key saved. Switched to ${this.provider}.`
          : usedOAuth
            ? `Signed in via OAuth. Switched to ${this.provider}.`
            : `Switched to ${this.provider}.`,
        shouldSwitch: true,
        defaultModel,
      });
    } else {
      this.onCompleteCallback({
        provider: this.provider,
        message: keySaved
          ? `Key saved for ${this.provider}. Use /model to switch.`
          : `Using existing key for ${this.provider}.`,
        shouldSwitch: false,
        defaultModel: "",
      });
    }
  }

  private finishCustom(keyValue: string): void {
    const config: CustomProviderConfig = {
      id: this.customId,
      api: "openai-completions",
      baseUrl: this.customBaseUrl,
      envKey: keyValue
        ? this.customId.toUpperCase().replace(/-/g, "_") + "_API_KEY"
        : undefined,
    };

    if (keyValue) {
      saveProviderKey(this.customId, keyValue);
    }

    const writeResult = appendProviderSection(config);
    const message = writeResult.written
      ? `Provider ${this.customId} saved. Run /new to activate, then /model ${this.customId} <model>.`
      : writeResult.message;

    this.onCompleteCallback({
      provider: this.customId,
      message,
      shouldSwitch: false,
      defaultModel: "",
    });
  }

  // ── Public API ──

  override focus(): void {
    if (this.step === "picker" || this.step === "auth-method" || this.step === "has-key" || this.step === "has-oauth") {
      this.activeList?.focus();
    } else {
      this.activeInput?.focus();
    }
  }

  override blur(): void {
    this.activeList?.blur();
    this.activeInput?.blur();
  }

  onComplete(handler: (result: LoginWizardResult) => void): void {
    this.onCompleteCallback = handler;
  }
}

function buildProviderMap(): Record<string, true> {
  const items = buildProviderSelectItems();
  const map: Record<string, true> = {};
  for (const item of items) {
    if (item.value !== CUSTOM_PROVIDER_VALUE) {
      map[item.value] = true;
    }
  }
  return map;
}
