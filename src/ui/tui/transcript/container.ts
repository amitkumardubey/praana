/**
 * Retained transcript tree — pi-style chat container.
 *
 * Semantic transcript entries render into real pi-tui Component children.
 * Streaming state is owned by TranscriptProjection; this class is only an adapter.
 */
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import { needsGap } from "./gap.js";
import type { TranscriptEntry } from "./model.js";
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
    this.requestRender();
  }

  renderEntries(entries: TranscriptEntry[]): void {
    super.clear();
    this.hydrateFromEntries(entries);
    this.requestRender();
  }

  // ─── Resume bootstrap ────────────────────────────────────────────────────

  private hydrateFromEntries(entries: TranscriptEntry[]): void {
    let prev: TranscriptEntry | undefined;
    for (const entry of entries) {
      if (needsGap(entry.role, prev?.role)) {
        this.addChild(new Spacer(1));
      }
      this.mountFinalizedEntry(entry);
      prev = entry;
    }
  }

  private mountFinalizedEntry(entry: TranscriptEntry): void {
    switch (entry.role) {
      case "user":
        this.addChild(new UserMessageComponent(entry.text, this.opts));
        break;
      case "assistant":
        this.addChild(
          new AssistantMessageComponent(entry.text, this.opts),
        );
        break;
      case "thinking":
        this.addChild(
          new ThinkingMessageComponent(entry.text, this.opts),
        );
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
        break;
      }
      case "recall":
        this.addChild(
          new RecallChipComponent(entry.preview, entry.count, entry.query ?? null, this.opts),
        );
        break;
      case "system":
        this.addChild(new SystemLineComponent(entry.text, this.opts));
        break;
      case "turn_footer":
        this.addChild(new TurnFooterComponent(entry.text));
        this.addChild(new Spacer(1));
        break;
    }
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}
