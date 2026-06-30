/**
 * TurnUiSink → TranscriptContainer routing (design §4 ambient signals).
 */
import type { TUI } from "@earendil-works/pi-tui";
import type { TurnUiSink, MemoryBannerStats } from "../../ui-events.js";
import type { LogEntry } from "../../logger.js";
import type { TranscriptContainer } from "./transcript/container.js";
import type { ToastRegion } from "./toast-region.js";
import { formatTurnFooterDigest } from "./tool-icons.js";

export interface SinkOpts {
  ambient: "inline" | "quiet";
  showThinking: () => boolean;
  onSpinnerMessage: (msg: string) => void;
  ctxWindowTokens: number;
  ctxUsedTokens: () => number;
}

export class PiTuiSink implements TurnUiSink {
  /** Buffer shell output into tool rows — raw stdout corrupts pi-tui redraws. */
  readonly shellLiveStream = false;

  private readonly tui: TUI;
  private readonly transcript: TranscriptContainer;
  private readonly toast: ToastRegion;
  private readonly opts: SinkOpts;

  private group = 1;
  private pendingToolArgs = new Map<string, Record<string, unknown>>();
  private bufferedStats: MemoryBannerStats | null = null;
  private recallPreview: string | null = null;
  private editCount = 0;
  private writeCount = 0;
  private ctxBeforePct = 0;

  constructor(
    tui: TUI,
    transcript: TranscriptContainer,
    toast: ToastRegion,
    opts: SinkOpts,
  ) {
    this.tui = tui;
    this.transcript = transcript;
    this.toast = toast;
    this.opts = opts;
  }

  get currentGroup(): number {
    return this.group;
  }

  nextGroup(): void {
    this.group++;
    this.bufferedStats = null;
    this.pendingToolArgs.clear();
    this.recallPreview = null;
    this.editCount = 0;
    this.writeCount = 0;
    this.ctxBeforePct = this.ctxPct(this.opts.ctxUsedTokens());
  }

  onTextDelta(delta: string): void {
    this.opts.onSpinnerMessage("replying…");
    this.transcript.appendAssistantDelta(delta, this.group);
  }

  onThinkingDelta(delta: string): void {
    this.opts.onSpinnerMessage("thinking…");
    if (this.opts.showThinking()) {
      this.transcript.appendThinkingDelta(delta, this.group);
    }
  }

  onToolCallsStart(): void {
    this.opts.onSpinnerMessage("working…");
    this.transcript.flushAssistant();
    this.transcript.flushThinking();
  }

  onToolCall(toolName: string, args: Record<string, unknown>): void {
    this.pendingToolArgs.set(toolName, args);
    this.transcript.addToolRow(toolName, args, this.group);
  }

  onToolResult(toolName: string, resultText: string, isError = false): void {
    const args = this.pendingToolArgs.get(toolName);
    this.transcript.setToolResult(toolName, resultText, isError, args);

    if (!isError) {
      if (toolName === "edit_file") this.editCount++;
      if (toolName === "write_file") this.writeCount++;
    }

    if (toolName === "recall") {
      this.recallPreview = this.extractRecallPreview(resultText);
    }
  }

  onDebug(): void {}
  onDebugBlock(): void {}

  onMemoryBanner(stats: MemoryBannerStats): void {
    this.bufferedStats = stats;

    if (this.opts.ambient === "inline" && stats.recallCalls > 0) {
      const preview =
        this.recallPreview ??
        (stats.recallHits > 0
          ? `${stats.recallHits} hit${stats.recallHits === 1 ? "" : "s"}`
          : "memory");
      this.transcript.addRecallChip(
        preview,
        stats.recallHits || stats.recallCalls,
        this.group,
      );
    }
  }

  onSpinnerStart(): void {}
  onSpinnerStop(): void {}
  onNewline(): void {}

  onFallback(text: string): void {
    this.transcript.addSystemLine(text);
  }

  onSystemLines(lines: string[]): void {
    for (const line of lines) {
      this.transcript.addSystemLine(line);
    }
  }

  onError(entry: LogEntry): void {
    if (entry.level === "error" || entry.level === "warn") {
      const msg = `[${entry.domain}] ${entry.message}`;
      this.transcript.addSystemLine(msg);
      this.toast.show(msg, "error");
      this.tui.requestRender();
    }
  }

  flushText(): void {}

  consumeTurnStats(): MemoryBannerStats | null {
    const s = this.bufferedStats;
    this.bufferedStats = null;
    return s;
  }

  appendTurnFooter(durationMs: number): void {
    const stats = this.bufferedStats ?? undefined;
    const ctxAfterPct = this.ctxPct(this.opts.ctxUsedTokens());
    const text = formatTurnFooterDigest({
      durationMs,
      stats,
      ambient: this.opts.ambient,
      editCount: this.editCount,
      writeCount: this.writeCount,
      ctxBeforePct: this.ctxBeforePct,
      ctxAfterPct,
    });
    this.transcript.addTurnFooter(text, this.group);
    this.transcript.flushAssistant();
    this.transcript.flushThinking();
  }

  private ctxPct(usedTokens: number): number {
    const window = this.opts.ctxWindowTokens;
    if (window <= 0) return 0;
    return Math.min(100, Math.round((usedTokens / window) * 100));
  }

  private extractRecallPreview(resultText: string): string | null {
    try {
      const parsed = JSON.parse(resultText) as {
        entries?: Array<{ content?: string }>;
      };
      const first = parsed.entries?.[0]?.content?.trim();
      if (!first) return null;
      return first.length > 72 ? `${first.slice(0, 71)}…` : first;
    } catch {
      return null;
    }
  }
}
