/**
 * In-place logout wizard — opened by bare `/logout`.
 *
 * Mirrors LoginWizard's structure but with a single step: a SelectRenderable
 * of only the providers the user has credentials for. Select + Enter removes
 * the credential (and config section if user-declared); Esc cancels.
 *
 * The wizard performs the removal itself (like LoginWizard calls
 * saveProviderKey itself); onComplete just handles the UI aftermath.
 */
import {
  BoxRenderable,
  TextRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type RenderContext,
  type KeyEvent,
} from "@opentui/core";
import { TUI_STYLE } from "./theme.js";
import { listStoredProviders, removeApiKey } from "../../credentials.js";
import { isUserDeclaredProvider } from "../../provider-registry.js";
import { removeProviderSection } from "../../setup/config-writer.js";

export interface AuthedProvider {
  id: string;
  label: string;
}

export interface LogoutWizardResult {
  provider: string;
  message: string;
  sectionRemoved: boolean;
  isActiveProvider: boolean;
}

export interface LogoutWizardOptions {
  currentProvider: string;
  onComplete: (result: LogoutWizardResult) => void;
  onCancel: () => void;
}

class LogoutSelect extends SelectRenderable {
  onCancel: (() => void) | null = null;

  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "escape" && this.onCancel) {
      this.onCancel();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

export class LogoutWizard extends BoxRenderable {
  private readonly currentProvider: string;
  private readonly onCompleteCallback: (result: LogoutWizardResult) => void;
  private readonly onCancelCallback: () => void;

  private readonly select: LogoutSelect;

  constructor(ctx: RenderContext, providers: AuthedProvider[], options: LogoutWizardOptions) {
    super(ctx, {
      id: "logout-wizard",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      padding: 1,
      title: "Log out",
    });

    this.currentProvider = options.currentProvider;
    this.onCompleteCallback = options.onComplete;
    this.onCancelCallback = options.onCancel;

    const prompt = new TextRenderable(ctx, {
      content: TUI_STYLE.info("Logout — select a provider to remove"),
    });
    this.add(prompt);

    this.select = new LogoutSelect(ctx, {
      id: "logout-wizard-list",
      width: 40,
      height: Math.max(6, Math.min(12, providers.length + 2)),
      options: providers.map((p) => ({
        name: p.label,
        description: "",
        value: p.id,
      })),
    });

    this.select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value?: unknown }) => {
      if (typeof option.value === "string") {
        this.removeProvider(option.value);
      }
    });

    this.select.onCancel = () => this.onCancelCallback();

    this.add(this.select);
  }

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

  focus(): void {
    this.select.focus();
  }

  blur(): void {
    this.select.blur();
  }
}

export function buildAuthedProviders(currentProvider: string): AuthedProvider[] {
  return listStoredProviders().map((p) => {
    const isActive = p === currentProvider;
    const isCustom = isUserDeclaredProvider(p);
    const tags: string[] = [];
    if (isActive) tags.push("active");
    if (isCustom) tags.push("custom");
    const label = tags.length > 0 ? `${p} (${tags.join(", ")})` : p;
    return { id: p, label };
  });
}
