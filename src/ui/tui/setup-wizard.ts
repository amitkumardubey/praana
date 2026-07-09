/**
 * pi-tui setup wizard — provider picker and config creation.
 */
import chalk from "chalk";
import {
  TUI,
  ProcessTerminal,
  Container,
  Text,
  Spacer,
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
} from "../../setup/provider-options.js";
import {
  buildProviderInstructions,
  describeProviderSetup,
  finalizeProviderSetup,
} from "../../setup/logic.js";
import { getSetupConfigPath } from "../../setup/config-writer.js";
import type { SetupResult } from "../../setup/types.js";

const SELECT_THEME: SelectListTheme = {
  selectedPrefix: TUI_STYLE.assistant,
  selectedText: (s: string) => chalk.bold(s),
  description: TUI_STYLE.muted,
  scrollInfo: TUI_STYLE.faint,
  noMatch: TUI_STYLE.muted,
};

const YES_NO_ITEMS: SelectItem[] = [
  { value: "yes", label: "Yes", description: "Create ~/.praana/config.toml" },
  { value: "no", label: "No", description: "Configure manually" },
];

const OVERWRITE_ITEMS: SelectItem[] = [
  { value: "yes", label: "Yes, overwrite", description: "Replace existing config" },
  { value: "no", label: "No, keep existing", description: "Leave config unchanged" },
];

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

    let selectedProvider: string | null = null;

    const termHeight = process.stdout.rows ?? 24;
    const maxVisible = Math.max(5, Math.min(14, termHeight - 14));

    const finish = (result: SetupResult) => {
      process.removeListener("SIGINT", sigintHandler);
      tui.stop();
      resolve(result);
    };

    const showProviderStep = () => {
      selectedProvider = null;
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
        selectedProvider = item.value;
        showConfirmStep();
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

    const showConfirmStep = () => {
      if (!selectedProvider) {
        showProviderStep();
        return;
      }

      root.clear();

      const info = describeProviderSetup(selectedProvider);
      const instructions = buildProviderInstructions(info);
      const prompt =
        info.needsExternalConfig
          ? "Create a config file anyway?"
          : "Create ~/.praana/config.toml?";

      body.setText([...instructions, "", prompt].join("\n"));
      header.setText(`Selected: ${selectedProvider}`);

      const list = new SelectList(YES_NO_ITEMS, 4, SELECT_THEME);
      list.onSelect = (item) => {
        if (item.value === "no") {
          finish(finalizeProviderSetup(selectedProvider!, "skip"));
          return;
        }
        if (existsSync(getSetupConfigPath())) {
          showOverwriteStep();
        } else {
          finish(finalizeProviderSetup(selectedProvider!, "write"));
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
      if (!selectedProvider) {
        showProviderStep();
        return;
      }

      root.clear();
      header.setText(`Config exists at ${getSetupConfigPath()}`);
      body.setText("Overwrite?");

      const list = new SelectList(OVERWRITE_ITEMS, 4, SELECT_THEME);
      list.onSelect = (item) => {
        if (item.value === "yes") {
          finish(finalizeProviderSetup(selectedProvider!, "overwrite"));
        } else {
          finish(finalizeProviderSetup(selectedProvider!, "skip"));
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
