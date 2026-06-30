import {
  formatEditDiffSummary,
  formatShellCompactSummary,
  formatShellOutputForDisplay,
  formatToolDisplay,
  summarizeResultForDisplay,
} from "../tool-icons.js";
import type {
  AssistantEntry,
  ThinkingEntry,
  TranscriptEntry,
  ToolEntry,
} from "./model.js";
import type { TuiTranscriptEvent } from "./events.js";

export class TranscriptProjection {
  private readonly useUnicode: boolean;
  private readonly entriesById = new Map<string, TranscriptEntry>();
  private readonly toolArgsById = new Map<string, Record<string, unknown>>();
  private order: string[] = [];

  constructor(opts: { useUnicode: boolean }) {
    this.useUnicode = opts.useUnicode;
  }

  apply(event: TuiTranscriptEvent): TranscriptEntry | null {
    switch (event.type) {
      case "turn_started":
      case "streams_finalized":
        return null;
      case "assistant_delta":
        return this.applyDelta(event.id, event.group, "assistant", event.delta);
      case "thinking_delta":
        return this.applyDelta(event.id, event.group, "thinking", event.delta);
      case "tool_call_started":
        return this.applyToolCall(event);
      case "tool_call_finished":
        return this.applyToolResult(event);
      case "user_submitted":
        return this.setEntry({
          id: event.id,
          role: "user",
          group: event.group,
          text: event.text,
        });
      case "recall_chip":
        return this.setEntry({
          id: event.id,
          role: "recall",
          group: event.group,
          preview: event.preview,
          count: event.count,
          query: event.query ?? null,
        });
      case "system_line":
        return this.setEntry({
          id: event.id,
          role: "system",
          group: event.group,
          text: event.text,
        });
      case "turn_footer":
        return this.setEntry({
          id: event.id,
          role: "turn_footer",
          group: event.group,
          text: event.text,
        });
      case "transcript_cleared":
        this.entriesById.clear();
        this.toolArgsById.clear();
        this.order = [];
        return null;
    }
  }

  entries(): TranscriptEntry[] {
    return this.order
      .map((id) => this.entriesById.get(id))
      .filter((entry): entry is TranscriptEntry => Boolean(entry))
      .map((entry) => ({ ...entry }));
  }

  load(entries: TranscriptEntry[]): void {
    this.entriesById.clear();
    this.toolArgsById.clear();
    this.order = [];
    for (const entry of entries) {
      this.entriesById.set(entry.id, { ...entry });
      this.order.push(entry.id);
    }
  }

  private applyDelta(
    id: string,
    group: number,
    role: "assistant" | "thinking",
    delta: string,
  ): TranscriptEntry {
    const existing = this.entriesById.get(id);
    if (existing && existing.role === role) {
      const updated = { ...existing, text: `${existing.text}${delta}` };
      this.entriesById.set(id, updated);
      return updated;
    }

    return this.setEntry({ id, role, group, text: delta } as AssistantEntry | ThinkingEntry);
  }

  private applyToolCall(event: Extract<TuiTranscriptEvent, { type: "tool_call_started" }>): ToolEntry {
    const display = formatToolDisplay(event.toolName, event.args, {
      useUnicode: this.useUnicode,
    });
    this.toolArgsById.set(event.id, event.args);
    return this.setEntry({
      id: event.id,
      role: "tool",
      group: event.group,
      toolName: event.toolName,
      toolIcon: display.icon,
      toolLabel: display.label,
      toolPending: display.pending,
    } as ToolEntry) as ToolEntry;
  }

  private applyToolResult(
    event: Extract<TuiTranscriptEvent, { type: "tool_call_finished" }>,
  ): TranscriptEntry | null {
    const existing = this.entriesById.get(event.id);
    if (!existing || existing.role !== "tool") return null;

    const raw = event.resultText;
    const shellDisplay =
      existing.toolName === "shell" ? formatShellOutputForDisplay(raw) : null;
    const summary = shellDisplay
      ? formatShellCompactSummary(raw)
      : summarizeResultForDisplay(raw);
    const args = event.args ?? this.toolArgsById.get(event.id);

    const next: ToolEntry = {
      ...existing,
      resultSummary: summary,
      resultText: raw,
      resultBody: shellDisplay?.body ?? undefined,
      isError: event.isError || (shellDisplay?.isError ?? false),
    };

    if (existing.toolName === "edit_file" && !next.isError) {
      const diff = formatEditDiffSummary(args);
      if (diff) next.resultSummary = diff;
    } else if (existing.toolName === "write_file" && !next.isError) {
      next.resultSummary = "written";
    }

    this.entriesById.set(event.id, next);
    return next;
  }

  private setEntry(entry: TranscriptEntry): TranscriptEntry {
    const copy = { ...entry } as TranscriptEntry;
    if (!this.entriesById.has(entry.id)) {
      this.order.push(entry.id);
    }
    this.entriesById.set(entry.id, copy);
    return copy;
  }
}
