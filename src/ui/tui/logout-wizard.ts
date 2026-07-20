/**
 * In-place logout wizard — opened by bare `/logout`.
 *
 * Mirrors LoginWizard's structure but with a single step: a SelectList of
 * only the providers the user has credentials for. Select + Enter removes
 * the credential (and config section if user-declared); Esc cancels.
 *
 * The wizard performs the removal itself (like LoginWizard calls
 * saveProviderKey itself); onComplete just handles the UI aftermath.
 */
import chalk from "chalk";
import {
  Container,
  Text,
  Spacer,
  SelectList,
  getKeybindings,
  type SelectItem,
  type SelectListTheme,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { TUI_STYLE } from "./theme.js";
import { listStoredProviders, removeApiKey } from "../../credentials.js";
import { isUserDeclaredProvider } from "../../provider-registry.js";
import { removeProviderSection } from "../../setup/config-writer.js";

const SELECT_THEME: SelectListTheme = {
  selectedPrefix: TUI_STYLE.assistant,
  selectedText: (s: string) => chalk.bold(s),
  description: TUI_STYLE.muted,
  scrollInfo: TUI_STYLE.faint,
  noMatch: TUI_STYLE.muted,
};

export interface LogoutWizardResult {
  provider: string;
  message: string;
  sectionRemoved: boolean;
  isActiveProvider: boolean;
}

export interface LogoutWizardOptions {
  tui: TUI;
  currentProvider: string;
  onComplete: (result: LogoutWizardResult) => void;
  onCancel: () => void;
}

export class LogoutWizard implements Component, Focusable {
  private readonly tui: TUI;
  private readonly currentProvider: string;
  private readonly onCompleteCallback: (result: LogoutWizardResult) => void;
  private readonly onCancelCallback: () => void;

  private readonly root = new Container();
  private activeList: SelectList | null = null;

  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
  }

  constructor(opts: LogoutWizardOptions) {
    this.tui = opts.tui;
    this.currentProvider = opts.currentProvider;
    this.onCompleteCallback = opts.onComplete;
    this.onCancelCallback = opts.onCancel;
    this.showPicker();
  }

  // ── Step: Provider picker ──

  private showPicker(): void {
    this.root.addChild(
      new Text(TUI_STYLE.info("Logout — select a provider to remove"), 0, 0),
    );
    this.root.addChild(new Spacer(1));

    const items = this.buildItems();
    const maxVisible = Math.max(6, Math.min(12, (process.stdout.rows ?? 24) - 10));
    const list = new SelectList(items, maxVisible, SELECT_THEME);
    list.onSelect = (item) => {
      this.removeProvider(item.value);
    };
    list.onCancel = () => this.onCancelCallback();

    this.activeList = list;
    this.root.addChild(list);
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(
        TUI_STYLE.faint("↑↓ navigate · Enter to log out · Esc to cancel"),
        0,
        0,
      ),
    );
  }

  private buildItems(): SelectItem[] {
    const stored = listStoredProviders();
    return stored.map((p) => {
      const isActive = p === this.currentProvider;
      const isCustom = isUserDeclaredProvider(p);
      const tags: string[] = [];
      if (isActive) tags.push("active");
      if (isCustom) tags.push("custom");
      const description = tags.length > 0 ? `(${tags.join(", ")})` : "";
      return { value: p, label: p, description };
    });
  }

  // ── Removal ──

  private removeProvider(provider: string): void {
    const isActive = provider === this.currentProvider;
    const isCustom = isUserDeclaredProvider(provider);

    const removed = removeApiKey(provider);
    let sectionRemoved = false;
    if (isCustom) {
      const sectionResult = removeProviderSection(provider);
      sectionRemoved = sectionResult.written;
    }

    const parts: string[] = [];
    if (removed || sectionRemoved) {
      parts.push(`Logged out: ${provider}`);
    } else {
      parts.push(`No credentials found for "${provider}".`);
    }
    if (sectionRemoved) {
      parts.push(`Removed [providers.${provider}] from config.toml.`);
      parts.push("Run /new to fully deactivate the provider.");
    }
    if (isActive) {
      parts.push(`⚠ ${provider} is your active provider — the next turn may fail.`);
      parts.push("Use /login to re-add, or /model to switch.");
    }

    this.onCompleteCallback({
      provider,
      message: parts.join(" "),
      sectionRemoved,
      isActiveProvider: isActive,
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
  }
}
