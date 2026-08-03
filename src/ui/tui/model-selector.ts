/**
 * OpenTUI model selector: search input + filtered select list.
 * Opened by bare `/model`; Enter switches immediately; Esc cancels.
 */
import {
  BoxRenderable,
  InputRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  type RenderContext,
  type KeyEvent,
} from "@opentui/core";
import { fuzzyFilter } from "../../model-listing.js";
import type { ModelListEntry } from "../../model-listing.js";

export interface ModelSelectorOptions {
  currentProvider: string;
  currentModelId: string;
  loadModels: () => Promise<ModelListEntry[]>;
  onSelect: (provider: string, modelId: string) => void;
  onCancel: () => void;
  maxVisible?: number;
}

interface FlatModel {
  provider: string;
  modelId: string;
  contextWindow: number | null;
}

class ModelSelectorInput extends InputRenderable {
  onEscape: (() => void) | null = null;

  override handleKeyPress(key: KeyEvent): boolean {
    if (key.name === "escape" && this.onEscape) {
      this.onEscape();
      return true;
    }
    return super.handleKeyPress(key);
  }
}

export class ModelSelector extends BoxRenderable {
  private readonly currentProvider: string;
  private readonly currentModelId: string;
  private readonly loadModels: () => Promise<ModelListEntry[]>;
  private readonly onSelectCallback: (provider: string, modelId: string) => void;
  private readonly onCancelCallback: () => void;
  private readonly maxVisible: number;

  private readonly input: ModelSelectorInput;
  private readonly select: SelectRenderable;

  private allModels: FlatModel[] = [];
  private filtered: FlatModel[] = [];
  private selectedIndex = 0;
  private loading = false;
  private loadError: string | null = null;

  constructor(ctx: RenderContext, options: ModelSelectorOptions) {
    super(ctx, {
      id: "model-selector",
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      padding: 1,
    });

    this.currentProvider = options.currentProvider;
    this.currentModelId = options.currentModelId;
    this.loadModels = options.loadModels;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.maxVisible = options.maxVisible ?? 10;

    this.input = new ModelSelectorInput(ctx, {
      id: "model-selector-input",
      placeholder: "Search models…",
    });

    this.select = new SelectRenderable(ctx, {
      id: "model-selector-list",
      width: 40,
      height: 8,
      options: [],
      showScrollIndicator: true,
    });

    this.add(this.input);
    this.add(this.select);

    this.input.on("input", (value: string) => this.onInputChange(value));
    this.input.on("enter", () => this.onInputSubmit());
    this.input.onEscape = () => this.onCancelCallback();

    this.select.on(SelectRenderableEvents.ITEM_SELECTED, (_index: number, option: { value?: unknown }) => {
      if (typeof option.value === "string") {
        const idx = option.value.indexOf("/");
        if (idx > 0) {
          const provider = option.value.slice(0, idx);
          const modelId = option.value.slice(idx + 1);
          this.onSelectCallback(provider, modelId);
        }
      }
    });

    this.select.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
      this.requestRender();
    });
  }

  /** Begin async model load (call after mounting). */
  start(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.loadError = null;
    this.requestRender();
    try {
      const entries = await this.loadModels();
      this.allModels = entries.map((e) => ({
        provider: e.provider,
        modelId: e.modelId,
        contextWindow: e.contextWindow,
      }));
      this.sortModels();
      this.filtered = this.allModels;
      this.selectedIndex = this.indexOfCurrent();
      this.loading = false;
      this.updateList();
    } catch (err) {
      this.loading = false;
      this.loadError = err instanceof Error ? err.message : String(err);
      this.updateList();
    }
    this.requestRender();
  }

  private sortModels(): void {
    this.allModels.sort((a, b) => {
      const aCurrent =
        a.provider === this.currentProvider && a.modelId === this.currentModelId;
      const bCurrent =
        b.provider === this.currentProvider && b.modelId === this.currentModelId;
      if (aCurrent && !bCurrent) return -1;
      if (!aCurrent && bCurrent) return 1;
      const byProvider = a.provider.localeCompare(b.provider);
      if (byProvider !== 0) return byProvider;
      return a.modelId.localeCompare(b.modelId);
    });
  }

  private indexOfCurrent(): number {
    const idx = this.filtered.findIndex(
      (m) =>
        m.provider === this.currentProvider && m.modelId === this.currentModelId,
    );
    return idx >= 0 ? idx : 0;
  }

  private formatCtx(window: number | null): string {
    if (window == null) return "";
    if (window >= 1_000_000) return ` ${(window / 1_000_000).toFixed(1)}M`;
    if (window >= 1000) return ` ${Math.round(window / 1000)}k`;
    return ` ${window}`;
  }

  private onInputChange(query: string): void {
    const q = query.trim();
    this.filtered = q
      ? fuzzyFilter(
          this.allModels,
          q,
          (m) => `${m.provider} ${m.modelId} ${m.provider}/${m.modelId}`,
        )
      : this.allModels;
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filtered.length - 1),
    );
    if (!q) this.selectedIndex = this.indexOfCurrent();
    this.updateList();
  }

  private onInputSubmit(): void {
    const selected = this.filtered[this.selectedIndex];
    if (selected) this.selectOption(selected);
  }

  private updateList(): void {
    if (this.loading || this.loadError) {
      return;
    }

    const options = this.filtered.map((item) => {
      const isCurrent =
        item.provider === this.currentProvider &&
        item.modelId === this.currentModelId;
      const label = `${item.modelId} [${item.provider}]${this.formatCtx(
        item.contextWindow,
      )}${isCurrent ? " ✓" : ""}`;
      return {
        name: label,
        description: "",
        value: `${item.provider}/${item.modelId}`,
      };
    });

    this.select.options = options;
    this.select.setSelectedIndex(
      Math.min(this.selectedIndex, Math.max(0, options.length - 1)),
    );
    this.requestRender();
  }

  private selectOption(model: FlatModel): void {
    this.onSelectCallback(model.provider, model.modelId);
  }

  focus(): void {
    this.input.focus();
  }

  blur(): void {
    this.input.blur();
  }
}
