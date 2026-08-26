/**
 * Solid-backed transcript state — source of truth for the Solid transcript view.
 */
import { createRoot, createSignal, type Accessor } from "solid-js";
import { createStore, produce, type Store } from "solid-js/store";
import type { TranscriptIndex, IndexedTranscriptEntry } from "./index.js";
import type { ToolEntry } from "./model.js";
import type { TranscriptMount } from "./mount.js";

export interface TranscriptStoreApi {
  readonly entries: Store<IndexedTranscriptEntry[]>;
  readonly streamingIds: Accessor<ReadonlySet<string>>;
  readonly focusMode: Accessor<boolean>;
  readonly selectedEntryId: Accessor<string | null>;
  readonly expandingIds: Accessor<ReadonlySet<string>>;
  readonly mount: TranscriptMount;
  loadIndex(index: TranscriptIndex): void;
  clear(): void;
  setFocused(focused: boolean): void;
  selectRelative(delta: number): void;
  selectEdge(which: "first" | "last"): void;
  toggleSelectedExpanded(): IndexedTranscriptEntry | null;
  setEntryExpanded(id: string, expanded: boolean): void;
  setExpanding(id: string, expanding: boolean): void;
  patchEntry(id: string, patch: Partial<IndexedTranscriptEntry>): void;
  dispose(): void;
}

function indexOfId(list: IndexedTranscriptEntry[], id: string): number {
  return list.findIndex((e) => e.id === id);
}

export function createTranscriptStore(): TranscriptStoreApi {
  return createRoot((dispose) => {
    const [entries, setEntries] = createStore<IndexedTranscriptEntry[]>([]);
    const [streamingIds, setStreamingIds] = createSignal<ReadonlySet<string>>(new Set());
    const [focusMode, setFocusMode] = createSignal(false);
    const [selectedEntryId, setSelectedEntryId] = createSignal<string | null>(null);
    const [expandingIds, setExpandingIds] = createSignal<ReadonlySet<string>>(new Set());

    const addStreaming = (id: string) => {
      setStreamingIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set<string>(prev);
        next.add(id);
        return next;
      });
    };

    const mount: TranscriptMount = {
      appendEntry(entry) {
        setEntries(
          produce((list) => {
            const i = indexOfId(list, entry.id);
            if (i >= 0) list[i] = { ...list[i]!, ...entry };
            else list.push({ ...entry });
          }),
        );
      },
      appendAssistantDelta(id, delta) {
        const i = indexOfId(entries, id);
        if (i < 0) return false;
        setEntries(
          produce((list) => {
            const e = list[i];
            if (e && (e.role === "assistant" || e.role === "thinking")) {
              e.text = `${e.text}${delta}`;
            }
          }),
        );
        addStreaming(id);
        return true;
      },
      appendThinkingDelta(id, delta) {
        const i = indexOfId(entries, id);
        if (i < 0) return false;
        setEntries(
          produce((list) => {
            const e = list[i];
            if (e && e.role === "thinking") {
              e.text = `${e.text}${delta}`;
            }
          }),
        );
        addStreaming(id);
        return true;
      },
      patchToolResult(id, entry: ToolEntry) {
        const i = indexOfId(entries, id);
        if (i < 0) return false;
        setEntries(
          produce((list) => {
            const e = list[i];
            if (e && e.role === "tool") {
              e.resultSummary = entry.resultSummary;
              e.resultBody = entry.resultBody;
              e.resultText = entry.resultText;
              e.isError = entry.isError;
            }
          }),
        );
        return true;
      },
      finalizeStreams(ids) {
        setStreamingIds((prev) => {
          const next = new Set<string>(prev);
          let changed = false;
          for (const id of ids) {
            if (id && next.delete(id)) changed = true;
          }
          return changed ? next : prev;
        });
      },
    };

    const loadIndex = (index: TranscriptIndex) => {
      const flat = index.groups.flatMap((g) => g.entries.map((e) => ({ ...e })));
      setEntries(flat);
      setStreamingIds(new Set<string>());
      setSelectedEntryId(null);
      setExpandingIds(new Set<string>());
      setFocusMode(false);
    };

    const clear = () => {
      setEntries([]);
      setStreamingIds(new Set<string>());
      setSelectedEntryId(null);
      setExpandingIds(new Set<string>());
      setFocusMode(false);
    };

    const setFocused = (focused: boolean) => {
      setFocusMode(focused);
      if (focused && !selectedEntryId() && entries.length > 0) {
        setSelectedEntryId(entries[entries.length - 1]!.id);
      }
    };

    const selectableIds = () => entries.map((e) => e.id);

    const selectRelative = (delta: number) => {
      const ids = selectableIds();
      if (ids.length === 0) return;
      const cur = selectedEntryId();
      const idx = cur ? ids.indexOf(cur) : -1;
      const next = Math.max(0, Math.min(ids.length - 1, (idx < 0 ? ids.length - 1 : idx) + delta));
      setSelectedEntryId(ids[next]!);
    };

    const selectEdge = (which: "first" | "last") => {
      const ids = selectableIds();
      if (ids.length === 0) return;
      setSelectedEntryId(which === "first" ? ids[0]! : ids[ids.length - 1]!);
    };

    const setEntryExpanded = (id: string, expanded: boolean) => {
      const i = indexOfId(entries, id);
      if (i < 0) return;
      setEntries(i, "expanded", expanded);
    };

    const setExpanding = (id: string, expanding: boolean) => {
      setExpandingIds((prev) => {
        const next = new Set<string>(prev);
        if (expanding) next.add(id);
        else next.delete(id);
        return next;
      });
    };

    const patchEntry = (id: string, patch: Partial<IndexedTranscriptEntry>) => {
      const i = indexOfId(entries, id);
      if (i < 0) return;
      setEntries(
        produce((list) => {
          const e = list[i];
          if (!e) return;
          Object.assign(e, patch);
        }),
      );
    };

    const toggleSelectedExpanded = (): IndexedTranscriptEntry | null => {
      const id = selectedEntryId();
      if (!id) return null;
      const i = indexOfId(entries, id);
      if (i < 0) return null;
      const entry = entries[i]!;
      if (entry.role !== "thinking" && entry.role !== "tool") return null;
      if (!entry.expandable && entry.role === "tool" && !entry.resultBody) return null;
      if (entry.role === "thinking" || entry.expandable || entry.resultBody) {
        const next = !(entry.expanded ?? (entry.role === "thinking"));
        setEntries(i, "expanded", next);
        return { ...entries[i]! };
      }
      return null;
    };

    return {
      entries,
      streamingIds,
      focusMode,
      selectedEntryId,
      expandingIds,
      mount,
      loadIndex,
      clear,
      setFocused,
      selectRelative,
      selectEdge,
      toggleSelectedExpanded,
      setEntryExpanded,
      setExpanding,
      patchEntry,
      dispose,
    };
  });
}
