/**
 * TurnUiSink → TranscriptContainer routing (design §4 ambient signals).
 */
import type { TUI } from "@earendil-works/pi-tui";
import type { TurnUiSink, MemoryBannerStats, ProviderUsageUpdate } from "../../ui-events.js";
import type { LogEntry } from "../../logger.js";
import type { TranscriptContainer } from "./transcript/container.js";
import {
  compactTranscriptEntry,
  type TranscriptCompactionOpts,
  type TranscriptEntry,
  type ToolEntry,
} from "./transcript/model.js";
import type { TranscriptProjection } from "./transcript/projection.js";
import type { ToastRegion } from "./toast-region.js";
import { formatTurnFooterDigest } from "./tool-icons.js";
import {
  type ContextDisplaySnapshot,
  type ContextHistoryDelta,
  mergeContextPreview,
} from "../../context-display.js";

export interface SinkOpts {
  ambient: "inline" | "quiet";
  showThinking: () => boolean;
  onSpinnerMessage: (msg: string) => void;
  ctxWindowTokens: number;
  engineMode: boolean;
  /** Called when the live context preview changes (glance bar). */
  onContextPreview?: (snapshot: ContextDisplaySnapshot) => void;
  onProviderUsage?: (update: ProviderUsageUpdate) => void;
  /** Getter for the current model label — used in the turn footer. */
  getModel?: () => string;
  projection: TranscriptProjection;
  persistEntry?: (entry: TranscriptEntry) => void;
  /** If set, heavy transcript rows are compacted before persistence. */
  persistCompaction?: TranscriptCompactionOpts;
  /** Called when a slash command wants its output shown in an overlay. */
  onSlashCommandResult?: (lines: string[]) => void;
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
  private ctxBeforeEngineMode = false;
  private turnBaseline: ContextDisplaySnapshot | null = null;
  private historyTokens = 0;
  private previewSnapshot: ContextDisplaySnapshot | null = null;
  private turnDistillerSavings = 0;
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

  getContextPreview(): ContextDisplaySnapshot | null {
    return this.previewSnapshot;
  }

  /** Drop live context preview after /clear so the glance bar shows a fresh baseline. */
  clearContextPreview(): void {
    this.previewSnapshot = null;
    this.turnBaseline = null;
    this.historyTokens = 0;
    this.turnDistillerSavings = 0;
    this.ctxBeforePct = 0;
    this.ctxBeforeEngineMode = false;
  }

  nextGroup(): void {
    this.group++;
    this.bufferedStats = null;
    this.pendingToolArgs.clear();
    this.recallPreview = null;
    this.recallQuery = null;
    this.editCount = 0;
    this.writeCount = 0;
    this.turnBaseline = null;
    this.historyTokens = 0;
    this.turnDistillerSavings = 0;
    this.assistantStreamId = null;
    this.thinkingStreamId = null;
    // Provisional until onTurnContextBaseline (real turns re-anchor to compile).
    const committed = this.previewSnapshot;
    this.ctxBeforePct = committed?.pct ?? 0;
    this.ctxBeforeEngineMode = committed?.mode === "engine";
    this.opts.projection.apply({ type: "turn_started", group: this.group });
  }

  onTurnContextBaseline(snapshot: ContextDisplaySnapshot): void {
    this.turnBaseline = snapshot;
    this.historyTokens = snapshot.historyTokens ?? 0;
    this.ctxBeforePct = snapshot.pct;
    this.ctxBeforeEngineMode = snapshot.mode === "engine";
    if (this.opts.engineMode) {
      this.previewSnapshot = snapshot;
      this.emitPreview();
    }
  }

  onContextHistoryDelta(delta: ContextHistoryDelta): void {
    if (!this.turnBaseline) return;
    if (!this.opts.engineMode) return;

    this.historyTokens += delta.tokensAdded;
    if (delta.distillerSavings) {
      this.turnDistillerSavings += delta.distillerSavings;
    }
    const next = mergeContextPreview(
      this.turnBaseline,
      this.historyTokens,
      this.turnDistillerSavings,
      true,
    );
    if (!this.previewSnapshot || next.usedTokens >= this.previewSnapshot.usedTokens) {
      this.previewSnapshot = next;
      this.emitPreview();
    }
  }

  onTurnContextCommit(snapshot: ContextDisplaySnapshot): void {
    const next =
      this.previewSnapshot && this.previewSnapshot.usedTokens > snapshot.usedTokens
        ? {
            ...this.previewSnapshot,
            distillerSavingsTurn:
              snapshot.distillerSavingsTurn ?? this.previewSnapshot.distillerSavingsTurn,
          }
        : snapshot;
    this.previewSnapshot = next;
    this.turnDistillerSavings = next.distillerSavingsTurn ?? this.turnDistillerSavings;
    this.emitPreview();
  }

  onProviderUsage(update: ProviderUsageUpdate): void {
    this.opts.onProviderUsage?.(update);
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

  onSlashCommandResult(lines: string[]): void {
    if (this.opts.onSlashCommandResult) {
      this.opts.onSlashCommandResult(lines);
    } else {
      this.onSystemLines(lines);
    }
  }

  appendShellRun(run: {
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    ok: boolean;
  }): void {
    const id = this.nextId("shell");
    const args = { command: run.command };
    const resultText = JSON.stringify({
      ok: run.ok,
      stdout: run.stdout,
      stderr: run.stderr,
      exitCode: run.exitCode,
    });

    this.applyTranscriptEvent({
      type: "tool_call_started",
      id,
      group: this.group,
      toolName: "shell",
      args,
    });
    this.applyTranscriptEvent({
      type: "tool_call_finished",
      id,
      group: this.group,
      toolName: "shell",
      resultText,
      isError: !run.ok,
      args,
    });
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
    const ctxAfterPct = this.previewSnapshot?.pct ?? 0;
    const model = this.opts.getModel?.();
    const text = formatTurnFooterDigest({
      durationMs,
      stats,
      ambient: this.opts.ambient,
      editCount: this.editCount,
      writeCount: this.writeCount,
      ctxBeforePct: this.ctxBeforePct,
      ctxAfterPct,
      engineMode: this.ctxBeforeEngineMode || this.opts.engineMode,
      distillerSavingsTurn: this.turnDistillerSavings,
      model,
      repeatFileReads: stats?.repeatFileReads,
    });
    this.finalizeStreams();
    this.applyTranscriptEvent({
      type: "turn_footer",
      id: this.nextId("footer"),
      group: this.group,
      text,
    });
  }

  private emitPreview(): void {
    if (this.previewSnapshot) {
      this.opts.onContextPreview?.(this.previewSnapshot);
    }
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.group}-${this.nextLocalId++}`;
  }

  private persist(entry: TranscriptEntry): void {
    const compaction = this.opts.persistCompaction;
    this.opts.persistEntry?.(
      compaction ? compactTranscriptEntry(entry, compaction) : entry,
    );
  }

  private applyTranscriptEvent(event: Parameters<TranscriptProjection["apply"]>[0]): void {
    const projection = this.opts.projection;
    const changed = projection.apply(event);

    switch (event.type) {
      case "assistant_delta": {
        if (!this.transcript.appendAssistantDelta(event.id, event.delta)) {
          this.transcript.renderEntries(projection.entries());
        }
        break;
      }
      case "thinking_delta": {
        if (!this.transcript.appendThinkingDelta(event.id, event.delta)) {
          this.transcript.renderEntries(projection.entries());
        }
        break;
      }
      case "tool_call_finished": {
        if (
          !changed ||
          changed.role !== "tool" ||
          !this.transcript.patchToolResult(changed.id, changed as ToolEntry)
        ) {
          this.transcript.renderEntries(projection.entries());
        }
        break;
      }
      default:
        this.transcript.renderEntries(projection.entries());
    }

    if (changed && event.type !== "assistant_delta" && event.type !== "thinking_delta") {
      this.persist(changed);
    }
  }

  private finalizeStreams(): void {
    const projection = this.opts.projection;
    projection.apply({ type: "streams_finalized", group: this.group });
    this.transcript.renderEntries(projection.entries());
    const entries = projection.entries();
    const assistant = entries.find((entry) => entry.id === this.assistantStreamId);
    const thinking = entries.find((entry) => entry.id === this.thinkingStreamId);
    if (assistant) this.persist(assistant);
    if (thinking) this.persist(thinking);
    this.assistantStreamId = null;
    this.thinkingStreamId = null;
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
