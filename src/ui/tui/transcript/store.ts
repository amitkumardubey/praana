/**
 * Mutable transcript store — the only writer of `entries`.
 *
 * The sink (`src/ui/tui/sink.ts`) drives every mutation here. Each mutation
 * that changes `entries` calls `tui.requestRender()` so the differential
 * renderer picks it up. Assistant and thinking entries support live streaming
 * via a "live entry" id (the last entry with that role that has not been
 * flushed) — deltas append to its `text` until `flushAssistant()` /
 * `flushThinking()` is called, which clears the live id and forces the next
 * delta to start a new entry. No `frozen` field on the entry types is needed
 * — the live id is tracked privately and is a stable O(1) reference.
 */
import type { TUI } from "@earendil-works/pi-tui";
import {
  formatShellOutputForDisplay,
  formatToolDisplay,
  summarizeResultForDisplay,
} from "../tool-icons.js";
import type {
  AssistantEntry,
  RecallEntry,
  SystemEntry,
  ThinkingEntry,
  ToolEntry,
  TranscriptEntry,
  TurnFooterEntry,
  UserEntry,
} from "./model.js";

export class TranscriptStore {
  entries: TranscriptEntry[];

  private readonly tui: TUI;
  private nextId = 1;
  private liveAssistantId: string | null = null;
  private liveThinkingId: string | null = null;

  constructor(tui: TUI, initial?: TranscriptEntry[]) {
    this.tui = tui;
    this.entries = initial ? [...initial] : [];
    // Initial entries are treated as finalized — the next delta starts a
    // fresh live entry. Matches the contract that bootstrap is a past turn.
  }

  // ─── Streaming: user + assistant + thinking ─────────────────────────────

  appendUser(text: string, group: number): void {
    const entry: UserEntry = { id: this.mintId(), role: "user", group, text };
    this.entries.push(entry);
    this.tui.requestRender();
  }

  appendAssistantDelta(delta: string, group: number): void {
    const live = this.findLive("assistant", this.liveAssistantId);
    if (live) {
      live.entry.text = live.entry.text + delta;
      this.tui.requestRender();
      return;
    }
    this.liveAssistantId = null;
    const entry: AssistantEntry = {
      id: this.mintId(),
      role: "assistant",
      group,
      text: delta,
    };
    this.liveAssistantId = entry.id;
    this.entries.push(entry);
    this.tui.requestRender();
  }

  flushAssistant(): void {
    this.liveAssistantId = null;
  }

  appendThinkingDelta(delta: string, group: number): void {
    const live = this.findLive("thinking", this.liveThinkingId);
    if (live) {
      live.entry.text = live.entry.text + delta;
      this.tui.requestRender();
      return;
    }
    this.liveThinkingId = null;
    const entry: ThinkingEntry = {
      id: this.mintId(),
      role: "thinking",
      group,
      text: delta,
    };
    this.liveThinkingId = entry.id;
    this.entries.push(entry);
    this.tui.requestRender();
  }

  flushThinking(): void {
    this.liveThinkingId = null;
  }

  // ─── Tool rows ──────────────────────────────────────────────────────────

  addToolRow(toolName: string, args: Record<string, unknown>, group: number): string {
    const display = formatToolDisplay(toolName, args);
    const entry: ToolEntry = {
      id: this.mintId(),
      role: "tool",
      group,
      toolName,
      toolIcon: display.icon,
      toolLabel: display.label,
      toolPending: display.pending,
    };
    this.entries.push(entry);
    this.tui.requestRender();
    return entry.id;
  }

  setToolResult(toolName: string, resultText: string, isError: boolean): void {
    const shellDisplay =
      toolName === "shell" ? formatShellOutputForDisplay(resultText) : null;
    const summary = shellDisplay?.summary ?? summarizeResultForDisplay(resultText);
    const body = shellDisplay?.body ?? undefined;
    const finalIsError = isError || (shellDisplay?.isError ?? false);

    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (
        entry !== undefined &&
        entry.role === "tool" &&
        entry.toolName === toolName &&
        entry.resultSummary === undefined
      ) {
        this.entries[i] = {
          ...entry,
          resultSummary: summary,
          resultText,
          resultBody: body,
          isError: finalIsError,
        };
        this.tui.requestRender();
        return;
      }
    }
  }

  // ─── Ambient + ephemeral ────────────────────────────────────────────────

  addRecallChip(preview: string, count: number, group: number): void {
    const entry: RecallEntry = {
      id: this.mintId(),
      role: "recall",
      group,
      preview,
      count,
    };
    this.entries.push(entry);
    this.tui.requestRender();
  }

  addTurnFooter(text: string, group: number): void {
    const entry: TurnFooterEntry = {
      id: this.mintId(),
      role: "turn_footer",
      group,
      text,
    };
    this.entries.push(entry);
    this.tui.requestRender();
  }

  addSystemLine(text: string): void {
    // System lines are not tied to a turn; group 0 is the "no-turn" bucket.
    const entry: SystemEntry = {
      id: this.mintId(),
      role: "system",
      group: 0,
      text,
    };
    this.entries.push(entry);
    this.tui.requestRender();
  }

  clear(): void {
    this.entries = [];
    this.liveAssistantId = null;
    this.liveThinkingId = null;
    this.tui.requestRender();
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private mintId(): string {
    return `entry-${this.nextId++}`;
  }

  /**
   * Find the live streaming entry for a given role. Returns the typed entry
   * if the id still points at an entry with the expected role; otherwise
   * null (caller should clear its live-id slot and start fresh).
   */
  private findLive<R extends TranscriptEntry["role"]>(
    role: R,
    liveId: string | null,
  ): { entry: Extract<TranscriptEntry, { role: R }> } | null {
    if (liveId === null) return null;
    const entry = this.entries.find((e) => e.id === liveId);
    if (entry === undefined || entry.role !== role) return null;
    return { entry: entry as Extract<TranscriptEntry, { role: R }> };
  }
}
