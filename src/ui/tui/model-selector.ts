/**
 * Pi-style model selector: search input + filtered list.
 * Opened by bare `/model`; Enter switches immediately; Esc cancels.
 */
import chalk from "chalk";
import {
  Container,
  Input,
  Text,
  Spacer,
  fuzzyFilter,
  getKeybindings,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { TUI_STYLE } from "./theme.js";
import type { ModelListEntry } from "../../model-listing.js";

interface FlatModel {
  provider: string;
  modelId: string;
  contextWindow: number | null;
}

export interface ModelSelectorOptions {
  tui: TUI;
  currentProvider: string;
  currentModelId: string;
  loadModels: () => Promise<ModelListEntry[]>;
  onSelect: (provider: string, modelId: string) => void;
  onCancel: () => void;
  maxVisible?: number;
}

/**
 * In-place model selector (same interaction model as pi's ModelSelectorComponent).
 * Not an overlay and not editor argument-autocomplete.
 */
export class ModelSelector implements Component, Focusable {
  private readonly tui: TUI;
  private readonly currentProvider: string;
  private readonly currentModelId: string;
  private readonly loadModels: () => Promise<ModelListEntry[]>;
  private readonly onSelectCallback: (provider: string, modelId: string) => void;
  private readonly onCancelCallback: () => void;
  private readonly maxVisible: number;

  private readonly root = new Container();
  private readonly searchInput = new Input();
  private readonly listContainer = new Container();
  private readonly statusText = new Text("", 0, 0);

  private allModels: FlatModel[] = [];
  private filtered: FlatModel[] = [];
  private selectedIndex = 0;
  private loading = true;
  private loadError: string | null = null;
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor(options: ModelSelectorOptions) {
    this.tui = options.tui;
    this.currentProvider = options.currentProvider;
    this.currentModelId = options.currentModelId;
    this.loadModels = options.loadModels;
    this.onSelectCallback = options.onSelect;
    this.onCancelCallback = options.onCancel;
    this.maxVisible = options.maxVisible ?? 10;

    this.root.addChild(
      new Text(TUI_STYLE.info("Select model"), 0, 0),
    );
    this.root.addChild(
      new Text(
        TUI_STYLE.muted(
          `Current: ${this.currentProvider}/${this.currentModelId}`,
        ),
        0,
        0,
      ),
    );
    this.root.addChild(new Spacer(1));
    this.root.addChild(this.searchInput);
    this.root.addChild(new Spacer(1));
    this.root.addChild(this.statusText);
    this.root.addChild(this.listContainer);
    this.root.addChild(new Spacer(1));
    this.root.addChild(
      new Text(
        TUI_STYLE.faint("↑↓ navigate · type to filter · Enter select · Esc cancel"),
        0,
        0,
      ),
    );

    this.searchInput.onSubmit = () => {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.select(selected);
    };

    this.statusText.setText(TUI_STYLE.muted("Loading models…"));
  }

  /** Begin async model load (call after mounting). */
  start(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.loadError = null;
    this.statusText.setText(TUI_STYLE.muted("Loading models…"));
    this.tui.requestRender();
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
      this.statusText.setText("");
      this.updateList();
    } catch (err) {
      this.loading = false;
      this.loadError = err instanceof Error ? err.message : String(err);
      this.statusText.setText(TUI_STYLE.error(this.loadError));
      this.updateList();
    }
    this.tui.requestRender();
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

  private filterModels(query: string): void {
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

  private formatCtx(window: number | null): string {
    if (window == null) return "";
    if (window >= 1_000_000) return ` ${(window / 1_000_000).toFixed(1)}M`;
    if (window >= 1000) return ` ${Math.round(window / 1000)}k`;
    return ` ${window}`;
  }

  private updateList(): void {
    this.listContainer.clear();

    if (this.loading) return;
    if (this.loadError) return;

    if (this.filtered.length === 0) {
      this.listContainer.addChild(
        new Text(TUI_STYLE.muted(" No matching models"), 0, 0),
      );
      return;
    }

    const maxVisible = this.maxVisible;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        this.filtered.length - maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filtered[i]!;
      const isSelected = i === this.selectedIndex;
      const isCurrent =
        item.provider === this.currentProvider &&
        item.modelId === this.currentModelId;
      const badge = TUI_STYLE.muted(`[${item.provider}]`);
      const check = isCurrent ? TUI_STYLE.success(" ✓") : "";
      const ctx = TUI_STYLE.faint(this.formatCtx(item.contextWindow));

      let line: string;
      if (isSelected) {
        const prefix = TUI_STYLE.assistant("→ ");
        const modelText = chalk.bold(TUI_STYLE.assistant(item.modelId));
        line = `${prefix}${modelText} ${badge}${ctx}${check}`;
      } else {
        line = `  ${item.modelId} ${badge}${ctx}${check}`;
      }
      this.listContainer.addChild(new Text(line, 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filtered.length) {
      this.listContainer.addChild(
        new Text(
          TUI_STYLE.muted(
            ` (${this.selectedIndex + 1}/${this.filtered.length})`,
          ),
          0,
          0,
        ),
      );
    }
  }

  private select(model: FlatModel): void {
    this.onSelectCallback(model.provider, model.modelId);
  }

  invalidate(): void {
    this.root.invalidate();
  }

  render(width: number): string[] {
    return this.root.render(width);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.select.up")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filtered.length - 1
          : this.selectedIndex - 1;
      this.updateList();
      this.tui.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      if (this.filtered.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filtered.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
      this.tui.requestRender();
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.filtered[this.selectedIndex];
      if (selected) this.select(selected);
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.onCancelCallback();
      return;
    }

    this.searchInput.handleInput(data);
    this.filterModels(this.searchInput.getValue());
    this.tui.requestRender();
  }
}
