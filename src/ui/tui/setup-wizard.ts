/**
 * OpenTUI setup wizard — provider picker, key collection, and config creation.
 *
 * Flow:
 *   1. Boot banner
 *   2. Provider picker (includes "Custom OpenAI-compatible endpoint")
 *   3. API key entry (masked) → saved to ~/.praana/credentials.json
 *   4. Model list fetch (best-effort) → model picker or manual entry
 *   5. Config write → ~/.praana/config.toml
 *
 * No "export KEY=..." instructions, no "restart" message.
 */
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  InputRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type RenderContext,
  type CliRenderer,
  type KeyEvent,
} from "@opentui/core";
import { existsSync } from "node:fs";
import { APP_VERSION } from "../../app-banner.js";
import { TUI_STYLE } from "./theme.js";
import { renderBootBanner } from "./banner.js";
import {
  buildProviderSelectItems,
  formatDetectedProviderLines,
  CUSTOM_PROVIDER_VALUE,
} from "../../setup/provider-options.js";
import {
  saveProviderKey,
  fetchProviderModels,
  fetchCustomProviderModels,
  pickDefaultModel,
  finalizeProviderSetup,
  isValidCustomProviderId,
  isValidBaseUrl,
  formatEnvKeyOfferMessage,
  adoptEnvKeyForProvider,
  providerRequiresApiKey,
  providerSupportsOAuth,
  bedrockNeedsApiKeyPrompt,
} from "../../setup/logic.js";
import { hasApiKey } from "../../llm.js";
import { hasCredentials, hasOAuthToken } from "../../credentials.js";
import { isOAuthOnlyProvider } from "../../oauth.js";
import { runOAuthLoginWithUi } from "./oauth-login-ui.js";
import { getSetupConfigPath } from "../../setup/config-writer.js";
import type { SetupResult, CustomProviderConfig } from "../../setup/types.js";
import type { ProviderCatalogModelEntry } from "../../provider-catalog.js";
import { fuzzyFilter } from "../../model-listing.js";

const YES_NO_OPTIONS = [
  { value: "yes", name: "Yes", description: "" },
  { value: "no", name: "No", description: "" },
];

class EscapableSelect extends SelectRenderable {
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
  private _maskedValue = "";
  override insertText(text: string): void {
    this._maskedValue += text;
    super.insertText("•".repeat(text.length));
  }
  override deleteCharBackward(): boolean {
    this._maskedValue = this._maskedValue.slice(0, -1);
    return super.deleteCharBackward();
  }
  override deleteChar(): boolean {
    this._maskedValue = this._maskedValue.slice(0, -1);
    return super.deleteChar();
  }
  override deleteWordBackward(): boolean {
    this._maskedValue = "";
    return super.deleteWordBackward();
  }
  get actualValue(): string {
    return this._maskedValue;
  }
  set actualValue(value: string) {
    this._maskedValue = value;
    this.setText("•".repeat(value.length));
    this.cursorOffset = value.length;
  }
  override focus(): void {
    super.focus();
    this._maskedValue = "";
  }
}

interface ProviderPickerItem {
  value: string;
  label: string;
  description?: string;
}

class ProviderPicker extends BoxRenderable {
  private readonly allItems: ProviderPickerItem[];
  private readonly listHeight: number;
  private select: EscapableSelect;
  private filter = "";

  onSelect?: (item: ProviderPickerItem) => void;
  onCancel?: () => void;
  onChange?: () => void;

  constructor(ctx: RenderContext, items: ProviderPickerItem[], listHeight: number) {
    super(ctx, { id: "provider-picker", flexDirection: "column" });
    this.allItems = items;
    this.listHeight = listHeight;

    this.select = new EscapableSelect(ctx, {
      id: "provider-picker-list",
      width: 40,
      height: listHeight,
      options: items.map((item) => ({ name: item.label, description: item.description ?? "", value: item.value })),
      showScrollIndicator: true,
    });
    this.select.onCancel = () => this.onCancel?.();
    this.select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
      const found = this.allItems.find((i) => i.value === option.value);
      if (found) this.onSelect?.(found);
    });

    this.add(this.select);
  }

  private filtered(): ProviderPickerItem[] {
    return this.filter
      ? fuzzyFilter(this.allItems, this.filter, (i) => `${i.value} ${i.label} ${i.description ?? ""}`)
      : this.allItems;
  }

  applyFilter(): void {
    const filtered = this.filtered();
    const options = filtered.map((item) => ({
      name: item.label,
      description: item.description ?? "",
      value: item.value,
    }));
    this.select.options = options;
    this.select.setSelectedIndex(0);
    this.onChange?.();
    this.requestRender();
  }

  override focus(): void {
    this.select.focus();
  }

  override blur(): void {
    this.select.blur();
  }
}

function versionNumber(): string {
  return APP_VERSION.replace(/^v/, "");
}

const AUTH_METHOD_ITEMS = [
  { value: "oauth", name: "Claude Pro/Max OAuth", description: "Browser sign-in" },
  { value: "api_key", name: "API key", description: "Paste ANTHROPIC_API_KEY" },
];

const REAUTH_ITEMS = [
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
}

export interface RunSetupWizardOptions {
  /** Test-only: pre-scripted input bytes fed to stdin instead of a real TTY. */
  simulateInput?: string[];
}

/** Run the interactive setup wizard in a standalone OpenTUI session. */
export async function runSetupWizardTui(options?: RunSetupWizardOptions): Promise<SetupResult> {
  const stdin = options?.simulateInput
    ? createMockStdin(options.simulateInput)
    : (process.stdin as unknown as NodeJS.ReadableStream);

  const renderer = await createCliRenderer({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: process.stdout,
    width: process.stdout.columns ?? 80,
    height: process.stdout.rows ?? 24,
    exitOnCtrlC: false,
  });

  try {
    return await runSetupWizardOnRenderer(renderer);
  } finally {
    renderer.destroy();
  }
}

async function runSetupWizardOnRenderer(renderer: CliRenderer): Promise<SetupResult> {
  return new Promise((resolve) => {
    const ctx = renderer;
    const root = new BoxRenderable(ctx, { id: "setup-wizard-root", flexDirection: "column" });

    const header = new TextRenderable(ctx, { content: "" });
    const body = new TextRenderable(ctx, { content: "" });
    const footer = new TextRenderable(ctx, { content: "" });

    const state: WizardState = {
      provider: "",
      isCustom: false,
      customProviderId: "",
      customBaseUrl: "",
      apiKey: "",
      keySaved: false,
      model: "",
    };

    const termHeight = process.stdout.rows ?? 24;
    const maxVisible = Math.max(5, Math.min(14, termHeight - 14));

    const finish = (result: SetupResult) => {
      resolve(result);
    };

    const getProviderForConfig = (): string =>
      state.isCustom ? state.customProviderId : state.provider;

    const getCustomProviderConfig = (): CustomProviderConfig | undefined => {
      if (!state.isCustom) return undefined;
      return {
        id: state.customProviderId,
        api: "openai-completions",
        baseUrl: state.customBaseUrl,
      };
    };

    const doFinalize = (action: "write" | "skip" | "overwrite") => {
      const provider = getProviderForConfig();
      const model = state.model || pickDefaultModel(provider) || undefined;
      finish(
        finalizeProviderSetup(provider, action, {
          model,
          customProvider: getCustomProviderConfig(),
          keySaved: state.keySaved,
        }),
      );
    };

    const clear = () => {
      for (const child of root.getChildren()) {
        root.remove(child);
      }
    };

    const render = () => {
      renderer.requestRender();
    };

    const focusComponent = (comp: { focus: () => void }) => {
      comp.focus();
    };

    const showStep = (renderFn: () => void) => {
      clear();
      renderFn();
      render();
    };

    // ── Step: Provider picker ──
    const showProviderStep = () => {
      showStep(() => {
        const detected = formatDetectedProviderLines();
        const intro = [
          "No provider configured. Let's set one up.",
          "",
          ...detected,
          ...(detected.length > 0 ? [""] : []),
          "Choose a provider:",
        ].join("\n");
        header.content = intro;

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" })); // spacer

        const picker = new ProviderPicker(
          ctx,
          buildProviderSelectItems(),
          maxVisible,
        );
        picker.onChange = () => render();
        picker.onSelect = (item) => {
          if (item.value === CUSTOM_PROVIDER_VALUE) {
            state.isCustom = true;
            showCustomIdStep();
          } else {
            state.isCustom = false;
            state.provider = item.value;
            if (item.value === "amazon-bedrock") {
              if (bedrockNeedsApiKeyPrompt()) {
                showBedrockKeyInputField();
              } else {
                showModelFetchStep();
              }
              return;
            }
            if (providerSupportsOAuth(item.value)) {
              showOAuthOrKeyStep(item.value);
              return;
            }
            showKeyEntryStep();
          }
        };
        picker.onCancel = () => {
          finish({ success: false, message: "Setup cancelled." });
        };

        root.add(picker);
        root.add(new TextRenderable(ctx, { content: "" })); // spacer
        root.add(footer);
        focusComponent(picker);
      });
    };

    // ── Step: OAuth vs API key ──
    const showOAuthOrKeyStep = (provider: string) => {
      if (isOAuthOnlyProvider(provider)) {
        if (hasCredentials(provider)) {
          showReuseOAuthStep(provider);
        } else {
          void runSetupOAuth(provider);
        }
        return;
      }

      showStep(() => {
        header.content = `Selected: ${provider}`;
        body.content = "How do you want to authenticate?";

        const select = new EscapableSelect(ctx, {
          id: "setup-auth-method",
          width: 40,
          height: 6,
          options: AUTH_METHOD_ITEMS,
        });
        select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
          if (option.value === "oauth") {
            void runSetupOAuth(provider);
          } else {
            showKeyEntryStep();
          }
        });
        select.onCancel = () => showProviderStep();

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(select);
        root.add(footer);
        focusComponent(select);
      });
    };

    const showReuseOAuthStep = (provider: string) => {
      showStep(() => {
        header.content = `Selected: ${provider}`;
        body.content = hasOAuthToken(provider)
          ? "✓ OAuth credentials already stored.\n\nSign in again?"
          : "✓ Credentials already stored.\n\nReplace them?";

        const select = new EscapableSelect(ctx, {
          id: "setup-reuse-oauth",
          width: 40,
          height: 6,
          options: REAUTH_ITEMS,
        });
        select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
          if (option.value === "yes") {
            void runSetupOAuth(provider);
          } else {
            state.keySaved = false;
            showModelFetchStep();
          }
        });
        select.onCancel = () => showProviderStep();

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(select);
        root.add(footer);
        focusComponent(select);
      });
    };

    const runSetupOAuth = async (provider: string) => {
      const abort = new AbortController();

      const promptText = (
        message: string,
        placeholder?: string,
        contextLines?: string[],
      ): Promise<string> => {
        return new Promise((resolve, reject) => {
          const onAbort = () => reject(new Error("cancelled"));
          abort.signal.addEventListener("abort", onAbort, { once: true });

          const input = new InputRenderable(ctx, { id: "setup-oauth-input" });
          input.onSubmit = () => {
            const trimmed = input.value.trim();
            if (!trimmed) return;
            abort.signal.removeEventListener("abort", onAbort);
            resolve(trimmed);
          };

          clear();
          header.content = `OAuth: ${provider}`;
          const parts: string[] = [];
          if (contextLines && contextLines.length > 0) {
            parts.push(...contextLines, "");
          }
          parts.push(message);
          if (placeholder) parts.push(TUI_STYLE.muted(placeholder));
          body.content = parts.join("\n");

          root.add(header);
          root.add(new TextRenderable(ctx, { content: "" }));
          root.add(body);
          root.add(new TextRenderable(ctx, { content: "" }));
          root.add(input);
          root.add(new TextRenderable(ctx, { content: TUI_STYLE.faint("Paste · Enter · Esc cancel") }));
          input.focus();
          render();
        });
      };

      const promptSelect = (
        message: string,
        options: readonly { id: string; label: string; description?: string }[],
      ): Promise<string | undefined> => {
        return new Promise((resolve) => {
          clear();
          header.content = `OAuth: ${provider}`;
          body.content = message;
          const select = new EscapableSelect(ctx, {
            id: "setup-oauth-select",
            width: 40,
            height: Math.min(8, options.length + 1),
            options: options.map((o) => ({ name: o.label, description: o.description ?? "", value: o.id })),
          });
          select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
            resolve(typeof option.value === "string" ? option.value : undefined);
          });
          select.onCancel = () => resolve(undefined);

          root.add(header);
          root.add(new TextRenderable(ctx, { content: "" }));
          root.add(body);
          root.add(new TextRenderable(ctx, { content: "" }));
          root.add(select);
          root.add(footer);
          focusComponent(select);
          render();
        });
      };

      clear();
      header.content = "OAuth";
      body.content = `Starting OAuth for ${provider}…`;
      root.add(header);
      root.add(new TextRenderable(ctx, { content: "" }));
      root.add(body);
      root.add(new TextRenderable(ctx, { content: TUI_STYLE.faint("Esc to cancel") }));
      render();

      try {
        await runOAuthLoginWithUi(provider, {
          signal: abort.signal,
          showStatus: (lines: string[]) => {
            body.content = lines.join("\n");
            render();
          },
          promptText,
          promptSelect,
        });
        if (abort.signal.aborted) return;
        state.keySaved = true;
        showModelFetchStep();
      } catch (err) {
        if (abort.signal.aborted) return;
        clear();
        header.content = `OAuth: ${provider}`;
        body.content = TUI_STYLE.error(
          `OAuth failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        const backSelect = new EscapableSelect(ctx, {
          id: "setup-oauth-back",
          width: 40,
          height: 4,
          options: [{ name: "Back to provider list", description: "", value: "back" }],
        });
        backSelect.on(SelectRenderableEvents.ITEM_SELECTED, () => showProviderStep());
        backSelect.onCancel = () => showProviderStep();
        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(backSelect);
        root.add(footer);
        focusComponent(backSelect);
        render();
      }
    };

    // ── Step: API key entry (catalog providers) ──
    const showKeyEntryStep = () => {
      const provider = state.provider;
      const keyExists = hasApiKey(provider);
      const envOffer = !keyExists ? formatEnvKeyOfferMessage(provider) : null;

      showStep(() => {
        header.content = `Selected: ${provider}`;

        if (keyExists) {
          body.content = [
            TUI_STYLE.success("✓ API key detected in credential store."),
            "",
            "Replace with a new key?",
          ].join("\n");

          const select = new EscapableSelect(ctx, {
            id: "setup-key-replace",
            width: 40,
            height: 6,
            options: YES_NO_OPTIONS,
          });
          select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
            if (option.value === "yes") {
              showKeyInputField(provider);
            } else {
              state.keySaved = false;
              showModelFetchStep();
            }
          });
          select.onCancel = () => showProviderStep();

          root.add(header);
          root.add(new TextRenderable(ctx, { content: "" }));
          root.add(body);
          root.add(new TextRenderable(ctx, { content: "" }));
          root.add(select);
          root.add(footer);
          focusComponent(select);
        } else if (envOffer) {
          body.content = envOffer;

          const select = new EscapableSelect(ctx, {
            id: "setup-env-key",
            width: 40,
            height: 6,
            options: YES_NO_OPTIONS,
          });
          select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
            if (option.value === "yes") {
              state.keySaved = adoptEnvKeyForProvider(provider);
              showModelFetchStep();
            } else {
              showKeyInputField(provider);
            }
          });
          select.onCancel = () => showProviderStep();

          root.add(header);
          root.add(new TextRenderable(ctx, { content: "" }));
          root.add(body);
          root.add(new TextRenderable(ctx, { content: "" }));
          root.add(select);
          root.add(footer);
          focusComponent(select);
        } else {
          showKeyInputField(provider);
        }
      });
    };

    const showKeyInputField = (provider: string, error?: string) => {
      const requiresKey = providerRequiresApiKey(provider);

      showStep(() => {
        header.content = `Selected: ${provider}`;
        const parts: string[] = [
          "Paste your API key.",
          TUI_STYLE.faint("  Stored in ~/.praana/credentials.json (0600)."),
          ...(error ? ["", TUI_STYLE.error(`✗ ${error}`)] : []),
          "",
        ];
        body.content = parts.join("\n");

        const input = new MaskedInput(ctx, { id: "setup-key-input" });
        input.onSubmit = () => {
          const trimmed = input.actualValue.trim();
          if (trimmed) {
            saveProviderKey(provider, trimmed);
            state.keySaved = true;
            showModelFetchStep();
            return;
          }
          if (requiresKey) {
            showKeyInputField(provider, "API key is required for this provider");
            return;
          }
          showModelFetchStep();
        };

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(input);
        root.add(footer);
        focusComponent(input);
      });
    };

    const showBedrockKeyInputField = (error?: string) => {
      showStep(() => {
        header.content = "Selected: amazon-bedrock";
        const parts: string[] = [
          "Paste your Bedrock API key (bearer token).",
          TUI_STYLE.faint("  Or set AWS credentials / AWS_BEARER_TOKEN_BEDROCK."),
          TUI_STYLE.faint("  Stored in ~/.praana/credentials.json (0600)."),
          ...(error ? ["", TUI_STYLE.error(`✗ ${error}`)] : []),
          "",
        ];
        body.content = parts.join("\n");

        const input = new MaskedInput(ctx, { id: "setup-bedrock-key-input" });
        input.onSubmit = () => {
          const trimmed = input.actualValue.trim();
          if (!trimmed) {
            showBedrockKeyInputField("Bedrock API key is required when AWS credentials are not detected");
            return;
          }
          saveProviderKey("amazon-bedrock", trimmed);
          state.keySaved = true;
          showModelFetchStep();
        };

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(input);
        root.add(footer);
        focusComponent(input);
      });
    };

    // ── Step: Custom provider id ──
    const showCustomIdStep = () => {
      showStep(() => {
        header.content = "Custom OpenAI-compatible endpoint";
        body.content = [
          "Enter a provider id (lowercase, no spaces).",
          TUI_STYLE.faint("  e.g. my-llama, vllm-local, lm-studio"),
          "",
        ].join("\n");

        const input = new InputRenderable(ctx, { id: "setup-custom-id" });
        input.onSubmit = () => {
          const validation = isValidCustomProviderId(input.value.trim());
          if (!validation.valid) {
            body.content = [
              "Enter a provider id (lowercase, no spaces).",
              TUI_STYLE.faint("  e.g. my-llama, vllm-local, lm-studio"),
              "",
              TUI_STYLE.error(`✗ ${validation.error}`),
              "",
            ].join("\n");
            render();
            return;
          }
          state.customProviderId = input.value.trim();
          showCustomBaseUrlStep();
        };

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(input);
        root.add(footer);
        focusComponent(input);
      });
    };

    // ── Step: Custom base URL ──
    const showCustomBaseUrlStep = () => {
      showStep(() => {
        header.content = `Custom provider: ${state.customProviderId}`;
        body.content = [
          "Enter the base URL.",
          TUI_STYLE.faint("  e.g. http://localhost:8080/v1, https://api.together.xyz/v1"),
          "",
        ].join("\n");

        const input = new InputRenderable(ctx, { id: "setup-custom-url" });
        input.onSubmit = () => {
          const validation = isValidBaseUrl(input.value.trim());
          if (!validation.valid) {
            body.content = [
              "Enter the base URL.",
              TUI_STYLE.faint("  e.g. http://localhost:8080/v1, https://api.together.xyz/v1"),
              "",
              TUI_STYLE.error(`✗ ${validation.error}`),
              "",
            ].join("\n");
            render();
            return;
          }
          state.customBaseUrl = input.value.trim();
          showCustomKeyStep();
        };

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(input);
        root.add(footer);
        focusComponent(input);
      });
    };

    // ── Step: Custom API key (optional) ──
    const showCustomKeyStep = () => {
      showStep(() => {
        header.content = `Custom provider: ${state.customProviderId}`;
        body.content = [
          "Enter API key (or press Enter to skip for keyless servers).",
          TUI_STYLE.faint("  Stored in ~/.praana/credentials.json (0600)."),
          "",
        ].join("\n");

        const input = new MaskedInput(ctx, { id: "setup-custom-key" });
        input.onSubmit = () => {
          if (input.actualValue.trim()) {
            saveProviderKey(state.customProviderId, input.actualValue);
            state.apiKey = input.actualValue.trim();
            state.keySaved = true;
          } else {
            state.keySaved = false;
          }
          showModelFetchStep();
        };

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(input);
        root.add(footer);
        focusComponent(input);
      });
    };

    // ── Step: Model fetch + picker ──
    const showModelFetchStep = () => {
      showStep(() => {
        const provider = getProviderForConfig();
        header.content = "Fetching models…";
        body.content = TUI_STYLE.faint(`  Contacting ${provider}…`);

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(footer);
        render();
      });

      const fetchPromise = state.isCustom
        ? fetchCustomProviderModels(state.customBaseUrl, state.apiKey || undefined)
        : fetchProviderModels(state.provider);

      fetchPromise.then((models) => {
        if (models && models.length > 0) {
          showModelPickerStep(models);
        } else {
          showManualModelStep();
        }
      });
    };

    const showModelPickerStep = (models: ProviderCatalogModelEntry[]) => {
      showStep(() => {
        const provider = getProviderForConfig();
        header.content = `Pick a default model for ${provider}`;

        const items = models.map((m) => ({
          value: m.id,
          name: m.id,
          description: m.contextWindow
            ? `${Math.round(m.contextWindow / 1000)}k context`
            : "",
        }));

        const select = new EscapableSelect(ctx, {
          id: "setup-model-picker",
          width: 40,
          height: maxVisible,
          options: items,
          showScrollIndicator: true,
        });
        select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
          state.model = typeof option.value === "string" ? option.value : "";
          showConfirmStep();
        });
        select.onCancel = () => showManualModelStep();

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(select);
        root.add(footer);
        focusComponent(select);
      });
    };

    const showManualModelStep = () => {
      showStep(() => {
        const provider = getProviderForConfig();
        const defaultModel = pickDefaultModel(provider);
        header.content = `Enter model id for ${provider}`;
        body.content = [
          "Enter the model id to use as default.",
          defaultModel
            ? TUI_STYLE.faint(`  Press Enter for default: ${defaultModel}`)
            : TUI_STYLE.faint("  e.g. llama-3.1-8b-instruct"),
          "",
        ].join("\n");

        const input = new InputRenderable(ctx, { id: "setup-custom-model" });
        if (defaultModel) input.value = defaultModel;
        input.onSubmit = () => {
          state.model = input.value.trim() || defaultModel || "";
          showConfirmStep();
        };

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(input);
        root.add(footer);
        focusComponent(input);
      });
    };

    // ── Step: Confirm + write ──
    const showConfirmStep = () => {
      const provider = getProviderForConfig();

      showStep(() => {
        let keyStatus: string;
        if (state.keySaved) {
          keyStatus = `Key: ${TUI_STYLE.success("saved to credential store")}`;
        } else if (hasApiKey(provider)) {
          keyStatus = `Key: ${TUI_STYLE.success("in credential store")}`;
        } else {
          keyStatus = "Key: (not set)";
        }

        const summary: string[] = [
          `Provider: ${TUI_STYLE.success(provider)}`,
          state.model ? `Model: ${state.model}` : "Model: (auto-detect)",
          keyStatus,
          "",
          "Create ~/.praana/config.toml?",
        ];
        header.content = `Selected: ${provider}`;
        body.content = summary.join("\n");

        const select = new EscapableSelect(ctx, {
          id: "setup-confirm",
          width: 40,
          height: 6,
          options: YES_NO_OPTIONS,
        });
        select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
          if (option.value === "no") {
            doFinalize("skip");
          } else if (existsSync(getSetupConfigPath())) {
            showOverwriteStep();
          } else {
            doFinalize("write");
          }
        });
        select.onCancel = () => showProviderStep();

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(select);
        root.add(footer);
        focusComponent(select);
      });
    };

    const showOverwriteStep = () => {
      showStep(() => {
        header.content = `Config exists at ${getSetupConfigPath()}`;
        body.content = "Overwrite?";

        const select = new EscapableSelect(ctx, {
          id: "setup-overwrite",
          width: 40,
          height: 6,
          options: YES_NO_OPTIONS,
        });
        select.on(SelectRenderableEvents.ITEM_SELECTED, (_index, option) => {
          if (option.value === "yes") {
            doFinalize("overwrite");
          } else {
            doFinalize("skip");
          }
        });
        select.onCancel = () => showConfirmStep();

        root.add(header);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(body);
        root.add(new TextRenderable(ctx, { content: "" }));
        root.add(select);
        root.add(footer);
        focusComponent(select);
      });
    };

    // Boot banner
    const width = process.stdout.columns ?? 80;
    const bannerLines = renderBootBanner({
      version: versionNumber(),
      summaryLines: ["Provider Setup"],
      width,
      noColor: !!process.env.NO_COLOR,
      banner: true,
    });
    for (const line of bannerLines) {
      process.stdout.write(line + "\n");
    }

    renderer.root.add(root);
    showProviderStep();
  });
}

function createMockStdin(chunks: string[]): NodeJS.ReadableStream {
  const { Readable } = require("node:stream");
  return Readable.from(chunks) as unknown as NodeJS.ReadableStream;
}
