/**
 * Minimal transcript mount surface used by OpenTuiSink.
 * Implemented by the Solid transcript store (and formerly TranscriptContainer).
 */
import type { IndexedTranscriptEntry } from "./index.js";
import type { ToolEntry } from "./model.js";

export interface TranscriptMount {
  appendEntry(entry: IndexedTranscriptEntry): void;
  appendAssistantDelta(id: string, delta: string): boolean;
  appendThinkingDelta(id: string, delta: string): boolean;
  patchToolResult(id: string, entry: ToolEntry): boolean;
  /** Mark streaming complete so markdown can finalize trailing tokens. */
  finalizeStreams?(ids: Array<string | null | undefined>): void;
}
