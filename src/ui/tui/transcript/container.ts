/**
 * Retained transcript tree — pi-style chat container.
 *
 * Semantic transcript entries render into real pi-tui Component children.
 * Streaming state is owned by TranscriptProjection; this class is only an adapter.
 */
import { Container, Spacer, type Component, type TUI } from "@earendil-works/pi-tui";
import { needsGap } from "./gap.js";
import type { TranscriptEntry, ToolEntry } from "./model.js";
import type { TranscriptRenderOpts } from "./opts.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { RecallChipComponent } from "./components/recall-chip.js";
import { SystemLineComponent } from "./components/system-line.js";
import { ThinkingMessageComponent } from "./components/thinking-message.js";
import { ToolRowComponent } from "./components/tool-row.js";
import { TurnFooterComponent } from "./components/turn-footer.js";
import { UserMessageComponent } from "./components/user-message.js";

export class TranscriptContainer extends Container {
  private readonly tui: TUI;
  private readonly opts: TranscriptRenderOpts;
  /** Parallel array mapping each child to its source entry id (null for spacers). */
  private entryIds: (string | null)[] = [];

  constructor(
    tui: TUI,
    opts: TranscriptRenderOpts,
    bootstrap?: TranscriptEntry[],
  ) {
    super();
    this.tui = tui;
    this.opts = opts;
    if (bootstrap && bootstrap.length > 0) {
      this.renderEntries(bootstrap);
    }
  }

  clear(): void {
    super.clear();
    this.entryIds = [];
    this.requestRender();
  }

  /**
   * Render a full sequence of entries, reusing unchanged components when
   * possible instead of clearing and rebuilding the entire tree.
   */
  renderEntries(entries: TranscriptEntry[]): void {
    const oldById = new Map<string, Component>();
    for (let i = 0; i < this.entryIds.length; i++) {
      const id = this.entryIds[i];
      if (id) oldById.set(id, this.children[i]!);
    }

    super.clear();
    this.entryIds = [];

    let prev: TranscriptEntry | undefined;
    for (const entry of entries) {
      if (needsGap(entry.role, prev?.role)) {
        this.addChild(new Spacer(1));
        this.entryIds.push(null);
      }
      const existing = oldById.get(entry.id);
      if (existing && this.tryUpdateComponent(existing, entry)) {
        this.addChild(existing);
        this.entryIds.push(entry.id);
        if (entry.role === "turn_footer") {
          this.addChild(new Spacer(1));
          this.entryIds.push(null);
        }
      } else {
        this.mountFinalizedEntry(entry);
      }
      prev = entry;
    }
    this.requestRender();
  }

  /** Fast path for streaming assistant text. Returns false if no component exists. */
  appendAssistantDelta(id: string, delta: string): boolean {
    const component = this.findEntryComponent(id);
    if (component instanceof AssistantMessageComponent) {
      component.appendDelta(delta);
      this.requestRender();
      return true;
    }
    return false;
  }

  /** Fast path for streaming thinking text. Returns false if no component exists. */
  appendThinkingDelta(id: string, delta: string): boolean {
    const component = this.findEntryComponent(id);
    if (component instanceof ThinkingMessageComponent) {
      component.appendDelta(delta);
      this.requestRender();
      return true;
    }
    return false;
  }

  /** Fast path for patching a tool row when its result arrives. */
  patchToolResult(id: string, entry: ToolEntry): boolean {
    const component = this.findEntryComponent(id);
    if (component instanceof ToolRowComponent) {
      component.setResult({
        resultSummary: entry.resultSummary,
        resultBody: entry.resultBody,
        isError: entry.isError,
      });
      this.requestRender();
      return true;
    }
    return false;
  }

  // ─── Resume bootstrap ────────────────────────────────────────────────────

  private findEntryComponent(id: string): Component | undefined {
    const index = this.entryIds.indexOf(id);
    return index >= 0 ? this.children[index] : undefined;
  }

  private tryUpdateComponent(
    component: Component,
    entry: TranscriptEntry,
  ): boolean {
    switch (entry.role) {
      case "user": {
        if (!(component instanceof UserMessageComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
      case "assistant": {
        if (!(component instanceof AssistantMessageComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
      case "thinking": {
        if (!(component instanceof ThinkingMessageComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
      case "tool": {
        if (!(component instanceof ToolRowComponent)) return false;
        if (
          component.getResultSummary() !== entry.resultSummary ||
          component.getResultBody() !== entry.resultBody ||
          component.getIsError() !== entry.isError
        ) {
          component.setResult({
            resultSummary: entry.resultSummary,
            resultBody: entry.resultBody,
            isError: entry.isError,
          });
        }
        return true;
      }
      case "recall": {
        if (!(component instanceof RecallChipComponent)) return false;
        if (
          component.getPreview() !== entry.preview ||
          component.getCount() !== entry.count ||
          component.getQuery() !== (entry.query ?? null)
        ) {
          return false;
        }
        return true;
      }
      case "system": {
        if (!(component instanceof SystemLineComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
      case "turn_footer": {
        if (!(component instanceof TurnFooterComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
    }
  }

  private mountFinalizedEntry(entry: TranscriptEntry): void {
    switch (entry.role) {
      case "user":
        this.addChild(new UserMessageComponent(entry.text, this.opts));
        this.entryIds.push(entry.id);
        break;
      case "assistant":
        this.addChild(new AssistantMessageComponent(entry.text, this.opts));
        this.entryIds.push(entry.id);
        break;
      case "thinking":
        this.addChild(new ThinkingMessageComponent(entry.text, this.opts));
        this.entryIds.push(entry.id);
        break;
      case "tool": {
        const row = new ToolRowComponent(
          {
            toolName: entry.toolName,
            toolIcon: entry.toolIcon,
            toolLabel: entry.toolLabel,
            toolPending: entry.toolPending,
            resultSummary: entry.resultSummary,
            resultBody: entry.resultBody,
            isError: entry.isError,
          },
          this.opts,
        );
        this.addChild(row);
        this.entryIds.push(entry.id);
        break;
      }
      case "recall":
        this.addChild(
          new RecallChipComponent(
            entry.preview,
            entry.count,
            entry.query ?? null,
            this.opts,
          ),
        );
        this.entryIds.push(entry.id);
        break;
      case "system":
        this.addChild(new SystemLineComponent(entry.text, this.opts));
        this.entryIds.push(entry.id);
        break;
      case "turn_footer":
        this.addChild(new TurnFooterComponent(entry.text));
        this.entryIds.push(entry.id);
        this.addChild(new Spacer(1));
        this.entryIds.push(null);
        break;
    }
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}
