/**
 * TurnUiSink → TranscriptContainer routing (design §4 ambient signals).
 */
import type { TUI } from "@earendil-works/pi-tui";
import type { TurnUiSink, MemoryBannerStats } from "../../ui-events.js";
import type { LogEntry } from "../../logger.js";
import type { TranscriptContainer } from "./transcript/container.js";
import type { TranscriptEntry } from "./transcript/model.js";
import type { TranscriptProjection } from "./transcript/projection.js";
import type { ToastRegion } from "./toast-region.js";
import { formatTurnFooterDigest } from "./tool-icons.js";
import { estimateTokens } from "../../token-estimate.js";

export interface SinkOpts {
  ambient: "inline" | "quiet";
  showThinking: () => boolean;
  onSpinnerMessage: (msg: string) => void;
  ctxWindowTokens: number;
  ctxUsedTokens: () => number;
  /** Called after each tool result with the cumulative estimated extra tokens
   *  added this turn. Use to update the glance bar ctx% live. */
  onLiveContextGrowth?: (extraTokens: number) => void;
  /** Getter for the current model label — used in the turn footer. */
  getModel?: () => string;
  projection: TranscriptProjection;
  persistEntry?: (entry: TranscriptEntry) => void;
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
  private recallQuery: string | null = null;
  private editCount = 0;
  private writeCount = 0;
  private ctxBeforePct = 0;
  /** Cumulative estimated tokens added by tool results this turn. */
  private extraContextTokens = 0;
  private assistantStreamId: string | null = null;
  private thinkingStreamId: string | null = null;
  private nextLocalId = 1;

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
    this.recallQuery = null;
    this.editCount = 0;
    this.writeCount = 0;
    this.extraContextTokens = 0;
    this.assistantStreamId = null;
    this.thinkingStreamId = null;
    this.ctxBeforePct = this.ctxPct(this.opts.ctxUsedTokens());
    this.opts.projection.apply({ type: "turn_started", group: this.group });
  }

  appendUser(text: string): void {
    this.applyTranscriptEvent({
      type: "user_submitted",
      id: this.nextId("user"),
      group: this.group,
      text,
    });
  }

  onTextDelta(delta: string): void {
    this.opts.onSpinnerMessage("replying…");
    this.assistantStreamId ??= this.nextId("assistant");
    this.applyTranscriptEvent({
      type: "assistant_delta",
      id: this.assistantStreamId,
      group: this.group,
      delta,
    });
  }

  onThinkingDelta(delta: string): void {
    this.opts.onSpinnerMessage("thinking…");
    if (this.opts.showThinking()) {
      this.thinkingStreamId ??= this.nextId("thinking");
      this.applyTranscriptEvent({
        type: "thinking_delta",
        id: this.thinkingStreamId,
        group: this.group,
        delta,
      });
    }
  }

  onToolCallsStart(): void {
    this.opts.onSpinnerMessage("working…");
    this.finalizeStreams();
  }

  onToolCall(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    this.pendingToolArgs.set(toolCallId, args);
    if (toolName === "recall") {
      this.recallQuery = typeof args.query === "string" ? args.query : null;
    }
    this.applyTranscriptEvent({
      type: "tool_call_started",
      id: toolCallId,
      group: this.group,
      toolName,
      args,
    });
  }

  onToolResult(toolCallId: string, toolName: string, resultText: string, isError = false): void {
    const args = this.pendingToolArgs.get(toolCallId);
    this.applyTranscriptEvent({
      type: "tool_call_finished",
      id: toolCallId,
      group: this.group,
      toolName,
      resultText,
      isError,
      args,
    });

    if (!isError) {
      if (toolName === "edit_file") this.editCount++;
      if (toolName === "write_file") this.writeCount++;
    }

    if (toolName === "recall") {
      this.recallPreview = this.extractRecallPreview(resultText);
    }

    // Estimate context growth from this tool result and notify the glance bar.
    if (this.opts.onLiveContextGrowth && resultText) {
      this.extraContextTokens += estimateTokens(resultText);
      this.opts.onLiveContextGrowth(this.extraContextTokens);
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
      this.applyTranscriptEvent({
        type: "recall_chip",
        id: this.nextId("recall"),
        group: this.group,
        preview,
        count: stats.recallHits || stats.recallCalls,
        query: this.recallQuery,
      });
    }
  }

  onSpinnerStart(): void {}
  onSpinnerStop(): void {}
  onNewline(): void {}

  onFallback(text: string): void {
    this.applyTranscriptEvent({
      type: "system_line",
      id: this.nextId("system"),
      group: this.group,
      text,
    });
  }

  onSystemLines(lines: string[]): void {
    for (const line of lines) {
      this.onFallback(line);
    }
  }

  onError(entry: LogEntry): void {
    if (entry.level === "error" || entry.level === "warn") {
      const msg = `[${entry.domain}] ${entry.message}`;
      this.applyTranscriptEvent({
        type: "system_line",
        id: this.nextId("system"),
        group: this.group,
        text: msg,
      });
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
    const model = this.opts.getModel?.();
    const text = formatTurnFooterDigest({
      durationMs,
      stats,
      ambient: this.opts.ambient,
      editCount: this.editCount,
      writeCount: this.writeCount,
      ctxBeforePct: this.ctxBeforePct,
      ctxAfterPct,
      model,
    });
    this.applyTranscriptEvent({
      type: "turn_footer",
      id: this.nextId("footer"),
      group: this.group,
      text,
    });
    this.finalizeStreams();
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.group}-${this.nextLocalId++}`;
  }

  private applyTranscriptEvent(event: Parameters<TranscriptProjection["apply"]>[0]): void {
    const projection = this.opts.projection;
    const changed = projection.apply(event);
    this.transcript.renderEntries(projection.entries());
    if (changed && event.type !== "assistant_delta" && event.type !== "thinking_delta") {
      this.opts.persistEntry?.(changed);
    }
  }

  private finalizeStreams(): void {
    const projection = this.opts.projection;
    projection.apply({ type: "streams_finalized", group: this.group });
    this.transcript.renderEntries(projection.entries());
    const entries = projection.entries();
    const assistant = entries.find((entry) => entry.id === this.assistantStreamId);
    const thinking = entries.find((entry) => entry.id === this.thinkingStreamId);
    if (assistant) this.opts.persistEntry?.(assistant);
    if (thinking) this.opts.persistEntry?.(thinking);
    this.assistantStreamId = null;
    this.thinkingStreamId = null;
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
