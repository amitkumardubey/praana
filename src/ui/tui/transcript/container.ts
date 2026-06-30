/**
 * Retained transcript tree — pi-style chat container.
 *
 * Each turn event appends or updates a real pi-tui Component child.
 * Resume bootstraps via hydrateFromEntries() then lives entirely in the tree.
 */
import { Container, Spacer, type TUI } from "@earendil-works/pi-tui";
import {
  formatEditDiffSummary,
  formatShellCompactSummary,
  formatShellOutputForDisplay,
  formatToolDisplay,
  summarizeResultForDisplay,
} from "../tool-icons.js";
import { needsGap } from "./gap.js";
import type { TranscriptEntry, TranscriptRole } from "./model.js";
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

  private streamingAssistant: AssistantMessageComponent | null = null;
  private streamingThinking: ThinkingMessageComponent | null = null;
  private readonly toolRows: ToolRowComponent[] = [];
  private lastRole: TranscriptRole | null = null;

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

  // ─── Live turn API (sink-driven) ─────────────────────────────────────────

  appendUser(text: string, _group: number): void {
    this.finalizeStreaming();
    this.addGap("user");
    const component = new UserMessageComponent(text, this.opts);
    this.addChild(component);
    this.lastRole = "user";
    this.requestRender();
  }

  appendAssistantDelta(delta: string, _group: number): void {
    if (this.streamingAssistant) {
      this.streamingAssistant.appendDelta(delta);
      this.requestRender();
      return;
    }
    this.addGap("assistant");
    this.streamingAssistant = new AssistantMessageComponent(delta, this.opts);
    this.addChild(this.streamingAssistant);
    this.lastRole = "assistant";
    this.requestRender();
  }

  flushAssistant(): void {
    this.streamingAssistant = null;
  }

  appendThinkingDelta(delta: string, _group: number): void {
    if (this.streamingThinking) {
      this.streamingThinking.appendDelta(delta);
      this.requestRender();
      return;
    }
    this.addGap("thinking");
    this.streamingThinking = new ThinkingMessageComponent(delta, this.opts);
    this.addChild(this.streamingThinking);
    this.lastRole = "thinking";
    this.requestRender();
  }

  flushThinking(): void {
    this.streamingThinking = null;
  }

  addToolRow(
    toolName: string,
    args: Record<string, unknown>,
    _group: number,
  ): void {
    this.finalizeStreaming();
    const display = formatToolDisplay(toolName, args, {
      useUnicode: this.opts.useUnicode,
    });
    this.addGap("tool");
    const component = new ToolRowComponent(
      {
        toolName,
        toolIcon: display.icon,
        toolLabel: display.label,
        toolPending: display.pending,
      },
      this.opts,
    );
    this.addChild(component);
    this.toolRows.push(component);
    this.lastRole = "tool";
    this.requestRender();
  }

  setToolResult(
    toolName: string,
    resultText: string,
    isError: boolean,
    args?: Record<string, unknown>,
  ): void {
    const shellDisplay =
      toolName === "shell" ? formatShellOutputForDisplay(resultText) : null;

    let summary =
      shellDisplay?.summary ?? summarizeResultForDisplay(resultText);

    if (toolName === "edit_file" && !isError) {
      const diff = formatEditDiffSummary(args);
      if (diff) summary = diff;
    } else if (toolName === "write_file" && !isError) {
      summary = "written";
    } else if (toolName === "shell" && shellDisplay) {
      summary = formatShellCompactSummary(resultText);
    }

    const body = shellDisplay?.body ?? undefined;
    const finalIsError = isError || (shellDisplay?.isError ?? false);

    for (let i = this.toolRows.length - 1; i >= 0; i--) {
      const row = this.toolRows[i]!;
      if (row.toolName === toolName && !row.hasResult()) {
        row.setResult({
          resultSummary: summary,
          resultBody: body,
          isError: finalIsError,
        });
        this.requestRender();
        return;
      }
    }
  }

  addRecallChip(preview: string, count: number, query: string | null, _group: number): void {
    this.addGap("recall");
    this.addChild(new RecallChipComponent(preview, count, query, this.opts));
    this.lastRole = "recall";
    this.requestRender();
  }

  addTurnFooter(text: string, _group: number): void {
    this.finalizeStreaming();
    this.addGap("turn_footer");
    this.addChild(new TurnFooterComponent(text));
    this.addChild(new Spacer(1));
    this.lastRole = "turn_footer";
    this.requestRender();
  }

  addSystemLine(text: string): void {
    this.addChild(new SystemLineComponent(text, this.opts));
    this.lastRole = "system";
    this.requestRender();
  }

  clear(): void {
    super.clear();
    this.streamingAssistant = null;
    this.streamingThinking = null;
    this.toolRows.length = 0;
    this.lastRole = null;
    this.requestRender();
  }

  renderEntries(entries: TranscriptEntry[]): void {
    super.clear();
    this.streamingAssistant = null;
    this.streamingThinking = null;
    this.toolRows.length = 0;
    this.lastRole = null;
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
        this.lastRole = "user";
        break;
      case "assistant":
        this.addChild(
          new AssistantMessageComponent(entry.text, this.opts),
        );
        this.lastRole = "assistant";
        break;
      case "thinking":
        this.addChild(
          new ThinkingMessageComponent(entry.text, this.opts),
        );
        this.lastRole = "thinking";
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
        this.toolRows.push(row);
        this.lastRole = "tool";
        break;
      }
      case "recall":
        this.addChild(
          new RecallChipComponent(entry.preview, entry.count, entry.query ?? null, this.opts),
        );
        this.lastRole = "recall";
        break;
      case "system":
        this.addChild(new SystemLineComponent(entry.text, this.opts));
        this.lastRole = "system";
        break;
      case "turn_footer":
        this.addChild(new TurnFooterComponent(entry.text));
        this.addChild(new Spacer(1));
        this.lastRole = "turn_footer";
        break;
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private addGap(role: TranscriptRole): void {
    if (needsGap(role, this.lastRole ?? undefined)) {
      this.addChild(new Spacer(1));
    }
  }

  private finalizeStreaming(): void {
    this.streamingAssistant = null;
    this.streamingThinking = null;
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}
