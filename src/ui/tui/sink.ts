/**
 * TurnUiSink implementation for the pi-tui TUI.
 *
 * Translates every TurnUiSink callback into a TranscriptStore mutation plus
 * tui.requestRender(). The store drives the actual Component rendering;
 * this file is pure routing logic.
 *
 * Turn state (group counter, stashed stats, per-tool args) lives here;
 * the store is stateless from this boundary's perspective.
 */
import type { TUI } from "@earendil-works/pi-tui";
import type { TurnUiSink, MemoryBannerStats } from "../../ui-events.js";
import type { LogEntry } from "../../logger.js";
import type { TranscriptStore } from "./transcript/store.js";
import type { ToastRegion } from "./toast-region.js";
import { formatTurnStatsSuffix } from "./tool-icons.js";

export interface SinkOpts {
  /** Whether memory recall chips appear inline or are folded into the footer. */
  ambient: "inline" | "quiet";
  /** Whether to materialise thinking blocks (controlled by /thinking). */
  showThinking: () => boolean;
  /** Called whenever the spinner label should change. */
  onSpinnerMessage: (msg: string) => void;
}

export class PiTuiSink implements TurnUiSink {
  readonly shellLiveStream = true;

  private readonly tui: TUI;
  private readonly store: TranscriptStore;
  private readonly toast: ToastRegion;
  private readonly opts: SinkOpts;

  /** Current turn group — incremented at each user message boundary. */
  private group = 1;
  /** Per-tool args stash for edit-count derivation (shell/edit counters). */
  private pendingToolArgs = new Map<string, Record<string, unknown>>();
  /** Stashed stats waiting for consumeTurnStats(). */
  private bufferedStats: MemoryBannerStats | null = null;

  constructor(tui: TUI, store: TranscriptStore, toast: ToastRegion, opts: SinkOpts) {
    this.tui = tui;
    this.store = store;
    this.toast = toast;
    this.opts = opts;
  }

  /** Call before each user turn to advance the group. */
  nextGroup(): void {
    this.group++;
    this.bufferedStats = null;
    this.pendingToolArgs.clear();
  }

  // ─── TurnUiSink callbacks ───────────────────────────────────────────────

  onTextDelta(delta: string): void {
    this.opts.onSpinnerMessage("replying…");
    this.store.appendAssistantDelta(delta, this.group);
  }

  onThinkingDelta(delta: string): void {
    this.opts.onSpinnerMessage("thinking…");
    if (this.opts.showThinking()) {
      this.store.appendThinkingDelta(delta, this.group);
    }
  }

  onToolCallsStart(): void {
    this.opts.onSpinnerMessage("working…");
    this.store.flushAssistant();
    this.store.flushThinking();
  }

  onToolCall(toolName: string, args: Record<string, unknown>): void {
    this.pendingToolArgs.set(toolName, args);
    this.store.addToolRow(toolName, args, this.group);
  }

  onToolResult(toolName: string, resultText: string, isError = false): void {
    this.store.setToolResult(toolName, resultText, isError);
  }

  onDebug(_message: string): void {
    // Debug output goes to the app logger / PRAANA_DEBUG file; not in transcript.
  }

  onDebugBlock(
    _stepIndex: number,
    _toolCalls: Array<{ toolName: string; args: Record<string, unknown> }>,
    _toolResults: Array<{ toolName: string; result: unknown }>
  ): void {
    // Debug blocks are not surfaced in the TUI transcript.
  }

  onMemoryBanner(stats: MemoryBannerStats): void {
    this.bufferedStats = stats;

    if (this.opts.ambient === "inline" && stats.recallCalls > 0) {
      // Best-effort preview: use first few chars of digest as quote placeholder.
      const preview = stats.digestLen > 0 ? `${stats.digestLen}c digest` : "memory";
      this.store.addRecallChip(preview, stats.recallCalls, this.group);
    }
  }

  onSpinnerStart(_text: string): void {
    // Spinner is managed externally (AppController wraps the sink).
  }

  onSpinnerStop(): void {
    // Same — external management.
  }

  onNewline(): void {
    // In the TUI the transcript handles layout; no raw newline needed.
  }

  onFallback(text: string): void {
    this.store.addSystemLine(text);
  }

  onSystemLines(lines: string[]): void {
    for (const line of lines) {
      this.store.addSystemLine(line);
    }
  }

  onError(entry: LogEntry): void {
    if (entry.level === "error" || entry.level === "warn") {
      // Errors are sticky: always go to transcript AND show a toast.
      const msg = `[${entry.domain}] ${entry.message}`;
      this.store.addSystemLine(msg);
      this.toast.show(msg, "error");
      this.tui.requestRender();
    }
  }

  flushText(): void {
    // No buffering — deltas are applied immediately.
  }

  consumeTurnStats(): MemoryBannerStats | null {
    const s = this.bufferedStats;
    this.bufferedStats = null;
    return s;
  }

  // ─── Turn footer ────────────────────────────────────────────────────────

  /**
   * Append the turn-end footer.  Called by run.ts after assistant_complete.
   * `durationMs` is wall-clock ms for the full turn.
   */
  appendTurnFooter(durationMs: number): void {
    const stats = this.bufferedStats ?? undefined;
    const duration =
      durationMs < 1000
        ? `${Math.max(0, Math.round(durationMs))}ms`
        : `${(durationMs / 1000).toFixed(1)}s`;

    const parts: string[] = [`✓`];

    // Recall count (quiet mode shows it here, inline mode already has a chip)
    if (this.opts.ambient === "quiet" && stats && stats.recallCalls > 0) {
      parts.push(`recall ${stats.recallCalls}`);
    }

    // Context window pressure
    if (stats && stats.promptTokens > 0) {
      const suffix = formatTurnStatsSuffix(stats);
      if (suffix) parts.push(suffix);
    }

    parts.push(duration);

    const text = parts.join(" · ");
    this.store.addTurnFooter(text, this.group);
    this.store.flushAssistant();
    this.store.flushThinking();
  }
}
