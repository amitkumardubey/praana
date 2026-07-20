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
import chalk from "chalk";
import {
  Container,
  Text,
  Spacer,
  Input,
  SelectList,
  getKeybindings,
  type SelectItem,
  type SelectListTheme,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
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
  pickDefaultModel,
  fetchProviderModels,
} from "../../setup/logic.js";
import { hasApiKey } from "../../llm.js";
import {
  isUserDeclaredProvider,
  listUserDeclaredProviderIds,
} from "../../provider-registry.js";
import {
  updateLlmProvider,
  appendProviderSection,
} from "../../setup/config-writer.js";
import type { CustomProviderConfig } from "../../setup/types.js";

const SELECT_THEME: SelectListTheme = {
  selectedPrefix: TUI_STYLE.assistant,
  selectedText: (s: string) => chalk.bold(s),
  description: TUI_STYLE.muted,
  scrollInfo: TUI_STYLE.faint,
  noMatch: TUI_STYLE.muted,
};

const YES_NO_ITEMS: SelectItem[] = [
  { value: "yes", label: "Yes — enter a new key", description: "" },
  { value: "no", label: "No — use existing key", description: "" },
];

type Step =
  | "picker"
  | "has-key"
  | "key"
  | "custom-id"
  | "custom-url"
  | "custom-key";

/**
 * Masked input — extends Input to display • characters instead of the
 * actual value. Used for API key entry.
 */
class MaskedInput extends Input {
  render(width: number): string[] {
    const actual = this.getValue();
    if (!actual) return super.render(width);
    this.setValue("•".repeat(actual.length));
    const lines = super.render(width);
    this.setValue(actual);
    return lines;
  }
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
  tui: TUI;
  currentProvider: string;
  initialProvider?: string;
  onComplete: (result: LoginWizardResult) => void;
  onCancel: () => void;
}

export class LoginWizard implements Component, Focusable {
  private readonly tui: TUI;
  private readonly currentProvider: string;
  private readonly onCompleteCallback: (result: LoginWizardResult) => void;
  private readonly onCancelCallback: () => void;

  private readonly root = new Container();
  private step: Step = "picker";
  private provider = "";
  private customId = "";
  private customBaseUrl = "";

  private activeInput: Input | null = null;
  private activeList: SelectList | null = null;

  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    if (this.activeInput) this.activeInput.focused = value;
  }

  constructor(opts: LoginWizardOptions) {
    this.tui = opts.tui;
    this.currentProvider = opts.currentProvider;
    this.onCompleteCallback = opts.onComplete;
    this.onCancelCallback = opts.onCancel;

    const hint = opts.initialProvider?.toLowerCase().trim();

    if (hint) {
      if (!isUserDeclaredProvider(hint) && hint in buildProviderMap()) {
        // Catalog provider
        this.provider = hint;
        if (providerRequiresApiKey(hint)) {
          this.step = hasApiKey(hint) ? "has-key" : "key";
        } else {
          // Keyless provider (ollama, bedrock) — just switch
          this.finishKeyless();
          return;
        }
      } else if (isUserDeclaredProvider(hint)) {
        // User-declared provider — just needs a key
        this.provider = hint;
        this.step = hasApiKey(hint) ? "has-key" : "key";
      } else {
        // Unknown provider → custom flow with pre-filled ID
        this.customId = hint;
        this.step = "custom-url";
      }
    } else {
      this.step = "picker";
    }

    this.showStep();
  }

  private showStep(): void {
    this.root.clear();
    this.activeInput = null;
    this.activeList = null;

    switch (this.step) {
      case "picker":
        this.showPicker();
        break;
      case "has-key":
        this.showHasKeyPrompt();
        break;
      case "key":
        this.showKeyEntry();
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
  }

  // ── Step: Provider picker ──

  private showPicker(): void {
    this.root.addChild(
      new Text(TUI_STYLE.info("Login — select a provider"), 0, 0),
    );
    this.root.addChild(
      new Text(
        TUI_STYLE.muted(`Current: ${this.currentProvider}`),
        0,
        0,
      ),
    );
    this.root.addChild(new Spacer(1));

    const items = this.buildPickerItems();
    const maxVisible = Math.max(6, Math.min(12, (process.stdout.rows ?? 24) - 10));
    const list = new SelectList(items, maxVisible, SELECT_THEME);
    list.onSelect = (item) => {
      if (item.value === CUSTOM_PROVIDER_VALUE) {
        this.step = "custom-id";
      } else {
        this.provider = item.value;
        if (providerRequiresApiKey(item.value) || isUserDeclaredProvider(item.value)) {
          this.step = hasApiKey(item.value) ? "has-key" : "key";
        } else {
          this.finishKeyless();
          return;
        }
      }
      this.showStep();
      this.tui.requestRender();
    };
    list.onCancel = () => this.onCancelCallback();

    this.activeList = list;
    this.root.addChild(list);
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(
        TUI_STYLE.faint("↑↓ navigate · Enter select · Esc cancel"),
        0,
        0,
      ),
    );
  }

  private buildPickerItems(): SelectItem[] {
    const items = buildProviderSelectItems();
    // Add user-declared providers that aren't in the catalog
    for (const id of listUserDeclaredProviderIds()) {
      if (!items.some((i) => i.value === id)) {
        items.push({ value: id, label: id, description: "(custom)" });
      }
    }
    return items;
  }

  // ── Step: Has key — replace or use existing? ──

  private showHasKeyPrompt(): void {
    this.root.addChild(
      new Text(
        TUI_STYLE.info(`You already have a key for ${this.provider}.`),
        0,
        0,
      ),
    );
    this.root.addChild(new Spacer(1));

    const list = new SelectList(YES_NO_ITEMS, 4, SELECT_THEME);
    list.onSelect = (item) => {
      if (item.value === "yes") {
        this.step = "key";
      } else {
        // Use existing key — just switch
        this.finish(false, "");
        return;
      }
      this.showStep();
      this.tui.requestRender();
    };
    list.onCancel = () => this.onCancelCallback();

    this.activeList = list;
    this.root.addChild(list);
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(
        TUI_STYLE.faint("↑↓ navigate · Enter select · Esc cancel"),
        0,
        0,
      ),
    );
  }

  // ── Step: API key entry ──

  private showKeyEntry(): void {
    const isCustom = isUserDeclaredProvider(this.provider);
    this.root.addChild(
      new Text(
        TUI_STYLE.info(
          isCustom
            ? `Enter API key for ${this.provider}`
            : `Enter API key for ${this.provider}`,
        ),
        0,
        0,
      ),
    );
    this.root.addChild(
      new Text(
        TUI_STYLE.muted("Saved to ~/.praana/credentials.json (0o600)"),
        0,
        0,
      ),
    );
    this.root.addChild(new Spacer(1));

    const input = new MaskedInput();
    input.onSubmit = (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        // Empty key — for user-declared providers, allow skip
        if (isCustom) {
          this.finish(false, "");
          return;
        }
        // For catalog providers, require a key
        this.root.clear();
        this.root.addChild(
          new Text(TUI_STYLE.error("Key cannot be empty. Press Esc to cancel."), 0, 0),
        );
        this.tui.requestRender();
        return;
      }
      this.finish(true, trimmed);
    };

    this.activeInput = input;
    this.activeInput.focused = this._focused;
    this.root.addChild(input);
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(
        TUI_STYLE.faint("Type key · Enter to save · Esc to cancel"),
        0,
        0,
      ),
    );
  }

  // ── Step: Custom provider ID ──

  private showCustomIdEntry(): void {
    this.root.addChild(
      new Text(
        TUI_STYLE.info("Custom OpenAI-compatible provider"),
        0,
        0,
      ),
    );
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(TUI_STYLE.muted("Enter a provider id (lowercase, e.g. my-llama):"), 0, 0),
    );
    this.root.addChild(new Spacer(1));

    const input = new Input();
    input.onSubmit = (value: string) => {
      const trimmed = value.trim();
      const validation = isValidCustomProviderId(trimmed);
      if (!validation.valid) {
        this.root.clear();
        this.root.addChild(new Text(TUI_STYLE.info("Custom provider"), 0, 0));
        this.root.addChild(new Spacer(1));
        this.root.addChild(
          new Text(TUI_STYLE.error(`Invalid: ${validation.error}`), 0, 0),
        );
        this.root.addChild(new Spacer(1));
        const retry = new Input();
        retry.onSubmit = (v: string) => {
          const t = v.trim();
          const val = isValidCustomProviderId(t);
          if (val.valid) {
            this.customId = t;
            this.step = "custom-url";
            this.showStep();
            this.tui.requestRender();
          } else {
            this.tui.requestRender();
          }
        };
        this.activeInput = retry;
        this.activeInput.focused = this._focused;
        this.root.addChild(retry);
        this.tui.requestRender();
        return;
      }
      this.customId = trimmed;
      this.step = "custom-url";
      this.showStep();
      this.tui.requestRender();
    };

    this.activeInput = input;
    this.activeInput.focused = this._focused;
    this.root.addChild(input);
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(TUI_STYLE.faint("Type id · Enter to continue · Esc to cancel"), 0, 0),
    );
  }

  // ── Step: Custom base URL ──

  private showCustomUrlEntry(): void {
    this.root.addChild(
      new Text(
        TUI_STYLE.info(`Configure ${this.customId}`),
        0,
        0,
      ),
    );
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(TUI_STYLE.muted("Base URL (e.g. http://localhost:8080/v1):"), 0, 0),
    );
    this.root.addChild(new Spacer(1));

    const input = new Input();
    input.onSubmit = (value: string) => {
      const trimmed = value.trim();
      const validation = isValidBaseUrl(trimmed);
      if (!validation.valid) {
        this.root.clear();
        this.root.addChild(
          new Text(TUI_STYLE.info(`Configure ${this.customId}`), 0, 0),
        );
        this.root.addChild(new Spacer(1));
        this.root.addChild(
          new Text(TUI_STYLE.error(`Invalid: ${validation.error}`), 0, 0),
        );
        this.root.addChild(new Spacer(1));
        const retry = new Input();
        retry.onSubmit = (v: string) => {
          const t = v.trim();
          const val = isValidBaseUrl(t);
          if (val.valid) {
            this.customBaseUrl = t;
            this.step = "custom-key";
            this.showStep();
            this.tui.requestRender();
          } else {
            this.tui.requestRender();
          }
        };
        this.activeInput = retry;
        this.activeInput.focused = this._focused;
        this.root.addChild(retry);
        this.tui.requestRender();
        return;
      }
      this.customBaseUrl = trimmed;
      this.step = "custom-key";
      this.showStep();
      this.tui.requestRender();
    };

    this.activeInput = input;
    this.activeInput.focused = this._focused;
    this.root.addChild(input);
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(TUI_STYLE.faint("Type URL · Enter to continue · Esc to cancel"), 0, 0),
    );
  }

  // ── Step: Custom API key (optional) ──

  private showCustomKeyEntry(): void {
    this.root.addChild(
      new Text(
        TUI_STYLE.info(`API key for ${this.customId}`),
        0,
        0,
      ),
    );
    this.root.addChild(
      new Text(
        TUI_STYLE.muted("Press Enter to skip for keyless local servers"),
        0,
        0,
      ),
    );
    this.root.addChild(new Spacer(1));

    const input = new MaskedInput();
    input.onSubmit = (value: string) => {
      this.finishCustom(value.trim());
    };

    this.activeInput = input;
    this.activeInput.focused = this._focused;
    this.root.addChild(input);
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(
        TUI_STYLE.faint("Type key · Enter to save (or skip) · Esc to cancel"),
        0,
        0,
      ),
    );
  }

  // ── Completion ──

  private showFetchingModels(): void {
    this.root.clear();
    this.activeInput = null;
    this.activeList = null;
    this.root.addChild(new Text(TUI_STYLE.info("Fetching models…"), 0, 0));
    this.tui.requestRender();
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

    if (!isCustom) {
      // Catalog provider — fetch live models, then update config and switch
      this.showFetchingModels();
      const liveModels = await fetchProviderModels(this.provider);
      const defaultModel = pickDefaultModel(this.provider, liveModels);
      updateLlmProvider(this.provider, defaultModel || undefined);
      this.onCompleteCallback({
        provider: this.provider,
        message: keySaved
          ? `Key saved. Switched to ${this.provider}.`
          : `Switched to ${this.provider}.`,
        shouldSwitch: true,
        defaultModel,
      });
    } else {
      // User-declared provider — just save key, don't switch
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

  // ── Component interface ──

  invalidate(): void {
    this.root.invalidate();
  }

  render(width: number): string[] {
    return this.root.render(width);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    // If a SelectList is active, route navigation keys to it
    if (this.activeList) {
      if (
        kb.matches(data, "tui.select.up") ||
        kb.matches(data, "tui.select.down") ||
        kb.matches(data, "tui.select.confirm") ||
        kb.matches(data, "tui.select.cancel")
      ) {
        this.activeList.handleInput(data);
        this.tui.requestRender();
        return;
      }
    }

    // If an Input is active, route to it
    if (this.activeInput) {
      if (kb.matches(data, "tui.select.cancel")) {
        this.onCancelCallback();
        return;
      }
      this.activeInput.handleInput(data);
      this.tui.requestRender();
      return;
    }
  }
}

// Helper to check if a provider id is in the catalog
function buildProviderMap(): Record<string, true> {
  // buildProviderSelectItems returns all catalog providers
  const items = buildProviderSelectItems();
  const map: Record<string, true> = {};
  for (const item of items) {
    if (item.value !== CUSTOM_PROVIDER_VALUE) {
      map[item.value] = true;
    }
  }
  return map;
}
