/**
 * pi-tui setup wizard — provider picker, key collection, and config creation.
 *
 * Flow:
 *   1. Provider picker (includes "Custom OpenAI-compatible endpoint")
 *   2. API key entry (masked) → saved to ~/.praana/credentials.json
 *   3. Model list fetch (best-effort) → model picker or manual entry
 *   4. Config write → ~/.praana/config.toml
 *
 * No "export KEY=..." instructions, no "restart" message.
 */
import chalk from "chalk";
import {
  TUI,
  ProcessTerminal,
  Container,
  Text,
  Spacer,
  Input,
  SelectList,
  fuzzyFilter,
  getKeybindings,
  type SelectItem,
  type SelectListTheme,
  type Component,
} from "@earendil-works/pi-tui";
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
} from "../../setup/logic.js";
import { hasApiKey } from "../../llm.js";
import { getSetupConfigPath } from "../../setup/config-writer.js";
import type { SetupResult, CustomProviderConfig } from "../../setup/types.js";
import type { ProviderCatalogModelEntry } from "../../provider-catalog.js";

const SELECT_THEME: SelectListTheme = {
  selectedPrefix: TUI_STYLE.assistant,
  selectedText: (s: string) => chalk.bold(s),
  description: TUI_STYLE.muted,
  scrollInfo: TUI_STYLE.faint,
  noMatch: TUI_STYLE.muted,
};

const YES_NO_ITEMS: SelectItem[] = [
  { value: "yes", label: "Yes", description: "" },
  { value: "no", label: "No", description: "" },
];

/**
 * Masked input — extends Input to display • characters instead of the
 * actual value. Used for API key entry. setValue preserves the cursor
 * position when the new value has the same length.
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

/** Provider list with type-to-filter (fuzzy) and arrow navigation. */
class ProviderPicker implements Component {
  private readonly allItems: SelectItem[];
  private readonly maxVisible: number;
  private list: SelectList;
  private filter = "";

  onSelect?: (item: SelectItem) => void;
  onCancel?: () => void;
  onChange?: () => void;

  constructor(items: SelectItem[], maxVisible: number) {
    this.allItems = items;
    this.maxVisible = maxVisible;
    this.list = this.createList(items);
  }

  private createList(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.maxVisible, SELECT_THEME);
    list.onSelect = (item) => this.onSelect?.(item);
    list.onCancel = () => this.onCancel?.();
    return list;
  }

  private applyFilter(): void {
    const query = this.filter.trim();
    const filtered = query
      ? fuzzyFilter(
          this.allItems,
          query,
          (item) => `${item.value} ${item.label} ${item.description ?? ""}`,
        )
      : this.allItems;
    const prev = this.list.getSelectedItem()?.value;
    this.list = this.createList(filtered);
    if (prev) {
      const idx = filtered.findIndex((i) => i.value === prev);
      if (idx >= 0) this.list.setSelectedIndex(idx);
    }
    this.onChange?.();
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const filterLabel = this.filter.length > 0 ? this.filter : "type to filter…";
    lines.push(TUI_STYLE.muted(`  Filter: ${filterLabel}`));
    lines.push("");
    lines.push(...this.list.render(width));
    lines.push("");
    lines.push(
      TUI_STYLE.faint(
        "  ↑↓ navigate · Enter select · type to filter · Backspace clear · Esc cancel",
      ),
    );
    return lines;
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (
      kb.matches(data, "tui.select.up") ||
      kb.matches(data, "tui.select.down") ||
      kb.matches(data, "tui.select.confirm") ||
      kb.matches(data, "tui.select.cancel")
    ) {
      this.list.handleInput(data);
      return;
    }
    if (kb.matches(data, "tui.editor.deleteCharBackward")) {
      if (this.filter.length > 0) {
        this.filter = this.filter.slice(0, -1);
        this.applyFilter();
      }
      return;
    }
    if (data.length === 1 && data >= " " && data <= "~") {
      this.filter += data;
      this.applyFilter();
    }
  }
}

function versionNumber(): string {
  return APP_VERSION.replace(/^v/, "");
}

/** Run the interactive setup wizard in a standalone pi-tui session. */
export async function runSetupWizardTui(): Promise<SetupResult> {
  return new Promise((resolve) => {
    const terminal = new ProcessTerminal();
    const tui = new TUI(terminal, true);

    const root = new Container();
    const header = new Text("", 0, 0);
    const body = new Text("", 0, 0);
    const footer = new Spacer(1);

    // Wizard state — tracks collected data across steps.
    const state = {
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
      process.removeListener("SIGINT", sigintHandler);
      tui.stop();
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

    // ── Step: Provider picker ──
    const showProviderStep = () => {
      root.clear();
      const detected = formatDetectedProviderLines();
      const intro = [
        "No provider API key found. Let's set one up.",
        "",
        ...detected,
        ...(detected.length > 0 ? [""] : []),
        "Choose a provider:",
      ].join("\n");
      header.setText(intro);

      const picker = new ProviderPicker(buildProviderSelectItems(), maxVisible);
      picker.onChange = () => tui.requestRender(true);
      picker.onSelect = (item) => {
        if (item.value === CUSTOM_PROVIDER_VALUE) {
          state.isCustom = true;
          showCustomIdStep();
        } else {
          state.isCustom = false;
          state.provider = item.value;
          showKeyEntryStep();
        }
      };
      picker.onCancel = () => {
        finish({ success: false, message: "Setup cancelled." });
      };

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(picker);
      root.addChild(footer);
      tui.setFocus(picker);
      tui.requestRender(true);
    };

    // ── Step: API key entry (catalog providers) ──
    const showKeyEntryStep = () => {
      const provider = state.provider;
      const keyExists = hasApiKey(provider);

      root.clear();

      if (keyExists) {
        header.setText(`Selected: ${provider}`);
        body.setText([
          chalk.green("✓ API key detected in credential store."),
          "",
          "Replace with a new key?",
        ].join("\n"));

        const list = new SelectList(YES_NO_ITEMS, 4, SELECT_THEME);
        list.onSelect = (item) => {
          if (item.value === "yes") {
            showKeyInputField(provider);
          } else {
            state.keySaved = false;
            showModelFetchStep();
          }
        };
        list.onCancel = () => showProviderStep();

        root.addChild(header);
        root.addChild(new Spacer(1));
        root.addChild(body);
        root.addChild(new Spacer(1));
        root.addChild(list);
        root.addChild(footer);
        tui.setFocus(list);
        tui.requestRender(true);
      } else {
        showKeyInputField(provider);
      }
    };

    const showKeyInputField = (provider: string) => {
      root.clear();
      header.setText(`Selected: ${provider}`);
      body.setText([
        "Paste your API key.",
        TUI_STYLE.faint("  Stored in ~/.praana/credentials.json (0600)."),
        "",
      ].join("\n"));

      const input = new MaskedInput();
      input.onSubmit = (value: string) => {
        if (value.trim()) {
          saveProviderKey(provider, value);
          state.keySaved = true;
        }
        showModelFetchStep();
      };
      input.onEscape = () => showProviderStep();

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(body);
      root.addChild(input);
      root.addChild(footer);
      tui.setFocus(input);
      tui.requestRender(true);
    };

    // ── Step: Custom provider id ──
    const showCustomIdStep = () => {
      root.clear();
      header.setText("Custom OpenAI-compatible endpoint");
      body.setText([
        "Enter a provider id (lowercase, no spaces).",
        TUI_STYLE.faint("  e.g. my-llama, vllm-local, lm-studio"),
        "",
      ].join("\n"));

      const input = new Input();
      input.onSubmit = (value: string) => {
        const validation = isValidCustomProviderId(value.trim());
        if (!validation.valid) {
          body.setText([
            "Enter a provider id (lowercase, no spaces).",
            TUI_STYLE.faint("  e.g. my-llama, vllm-local, lm-studio"),
            "",
            chalk.red(`✗ ${validation.error}`),
            "",
          ].join("\n"));
          tui.requestRender(true);
          return;
        }
        state.customProviderId = value.trim();
        showCustomBaseUrlStep();
      };
      input.onEscape = () => showProviderStep();

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(body);
      root.addChild(input);
      root.addChild(footer);
      tui.setFocus(input);
      tui.requestRender(true);
    };

    // ── Step: Custom base URL ──
    const showCustomBaseUrlStep = () => {
      root.clear();
      header.setText(`Custom provider: ${state.customProviderId}`);
      body.setText([
        "Enter the base URL.",
        TUI_STYLE.faint("  e.g. http://localhost:8080/v1, https://api.together.xyz/v1"),
        "",
      ].join("\n"));

      const input = new Input();
      input.onSubmit = (value: string) => {
        const validation = isValidBaseUrl(value.trim());
        if (!validation.valid) {
          body.setText([
            "Enter the base URL.",
            TUI_STYLE.faint("  e.g. http://localhost:8080/v1, https://api.together.xyz/v1"),
            "",
            chalk.red(`✗ ${validation.error}`),
            "",
          ].join("\n"));
          tui.requestRender(true);
          return;
        }
        state.customBaseUrl = value.trim();
        showCustomKeyStep();
      };
      input.onEscape = () => showCustomIdStep();

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(body);
      root.addChild(input);
      root.addChild(footer);
      tui.setFocus(input);
      tui.requestRender(true);
    };

    // ── Step: Custom API key (optional) ──
    const showCustomKeyStep = () => {
      root.clear();
      header.setText(`Custom provider: ${state.customProviderId}`);
      body.setText([
        "Enter API key (or press Enter to skip for keyless servers).",
        TUI_STYLE.faint("  Stored in ~/.praana/credentials.json (0600)."),
        "",
      ].join("\n"));

      const input = new MaskedInput();
      input.onSubmit = (value: string) => {
        if (value.trim()) {
          saveProviderKey(state.customProviderId, value);
          state.apiKey = value.trim();
          state.keySaved = true;
        } else {
          state.keySaved = false;
        }
        showModelFetchStep();
      };
      input.onEscape = () => showCustomBaseUrlStep();

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(body);
      root.addChild(input);
      root.addChild(footer);
      tui.setFocus(input);
      tui.requestRender(true);
    };

    // ── Step: Model fetch + picker ──
    const showModelFetchStep = () => {
      root.clear();
      const provider = getProviderForConfig();
      header.setText("Fetching models…");
      body.setText(TUI_STYLE.faint(`  Contacting ${provider}…`));

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(body);
      root.addChild(footer);
      tui.requestRender(true);

      // Start async fetch — the TUI continues rendering while we wait.
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
      root.clear();
      const provider = getProviderForConfig();
      header.setText(`Pick a default model for ${provider}`);

      const items: SelectItem[] = models.map((m) => ({
        value: m.id,
        label: m.id,
        description: m.contextWindow
          ? `${Math.round(m.contextWindow / 1000)}k context`
          : undefined,
      }));

      const list = new SelectList(items, maxVisible, SELECT_THEME);
      list.onSelect = (item) => {
        state.model = item.value;
        showConfirmStep();
      };
      list.onCancel = () => showManualModelStep();

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(list);
      root.addChild(footer);
      tui.setFocus(list);
      tui.requestRender(true);
    };

    const showManualModelStep = () => {
      root.clear();
      const provider = getProviderForConfig();
      const defaultModel = pickDefaultModel(provider);
      header.setText(`Enter model id for ${provider}`);
      const hint = defaultModel
        ? TUI_STYLE.faint(`  Press Enter for default: ${defaultModel}`)
        : TUI_STYLE.faint("  e.g. llama-3.1-8b-instruct");
      body.setText([
        "Enter the model id to use as default.",
        hint,
        "",
      ].join("\n"));

      const input = new Input();
      if (defaultModel) input.setValue(defaultModel);
      input.onSubmit = (value: string) => {
        state.model = value.trim() || defaultModel;
        showConfirmStep();
      };
      input.onEscape = () => showModelFetchStep();

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(body);
      root.addChild(input);
      root.addChild(footer);
      tui.setFocus(input);
      tui.requestRender(true);
    };

    // ── Step: Confirm + write ──
    const showConfirmStep = () => {
      const provider = getProviderForConfig();
      root.clear();

      const keyStatus = state.keySaved
        ? `Key: ${chalk.green("saved to credential store")}`
        : hasApiKey(provider)
          ? `Key: ${chalk.green("in credential store")}`
          : "Key: (not set)";

      const summary: string[] = [
        `Provider: ${chalk.bold(provider)}`,
        state.model ? `Model: ${state.model}` : "Model: (auto-detect)",
        keyStatus,
        "",
        "Create ~/.praana/config.toml?",
      ];
      header.setText(`Selected: ${provider}`);
      body.setText(summary.join("\n"));

      const list = new SelectList(YES_NO_ITEMS, 4, SELECT_THEME);
      list.onSelect = (item) => {
        if (item.value === "no") {
          doFinalize("skip");
        } else if (existsSync(getSetupConfigPath())) {
          showOverwriteStep();
        } else {
          doFinalize("write");
        }
      };
      list.onCancel = () => showProviderStep();

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(body);
      root.addChild(new Spacer(1));
      root.addChild(list);
      root.addChild(footer);
      tui.setFocus(list);
      tui.requestRender(true);
    };

    const showOverwriteStep = () => {
      root.clear();
      header.setText(`Config exists at ${getSetupConfigPath()}`);
      body.setText("Overwrite?");

      const list = new SelectList(YES_NO_ITEMS, 4, SELECT_THEME);
      list.onSelect = (item) => {
        if (item.value === "yes") {
          doFinalize("overwrite");
        } else {
          doFinalize("skip");
        }
      };
      list.onCancel = () => showConfirmStep();

      root.addChild(header);
      root.addChild(new Spacer(1));
      root.addChild(body);
      root.addChild(new Spacer(1));
      root.addChild(list);
      root.addChild(footer);
      tui.setFocus(list);
      tui.requestRender(true);
    };

    const sigintHandler = () => {
      finish({ success: false, message: "Setup cancelled." });
    };
    process.on("SIGINT", sigintHandler);

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

    tui.addChild(root);
    tui.start();
    showProviderStep();
  });
}
