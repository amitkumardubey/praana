/**
 * Solid scrollable transcript — renders store entries with sticky-bottom scroll.
 */
import { For, Show, createEffect } from "solid-js";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { useBindings } from "@opentui/keymap/solid";
import { needsGap } from "./gap.js";
import { TranscriptEntryView } from "./entries.js";
import type { TranscriptStoreApi } from "./store.js";
import type { TranscriptRenderOpts } from "./opts.js";
import type { ExpandedContentResult, IndexedTranscriptEntry } from "./index.js";

export interface TranscriptViewProps {
  store: TranscriptStoreApi;
  opts: TranscriptRenderOpts;
  onExpand?: (
    entry: IndexedTranscriptEntry,
  ) => Promise<ExpandedContentResult> | ExpandedContentResult;
  onRequestFocus?: () => void;
}

export function TranscriptView(props: TranscriptViewProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();

  createEffect(() => {
    // Re-render when store signals change (entries are a store; streaming/focus are signals).
    void props.store.streamingIds();
    void props.store.focusMode();
    void props.store.selectedEntryId();
    void props.store.entries.length;
    renderer.requestRender();
  });

  useBindings(() => ({
    bindings: props.store.focusMode()
      ? [
          {
            key: "escape",
            cmd: () => {
              props.store.setFocused(false);
              props.onRequestFocus?.();
            },
          },
          { key: "up", cmd: () => props.store.selectRelative(-1) },
          { key: "down", cmd: () => props.store.selectRelative(1) },
          { key: "pageup", cmd: () => props.store.selectEdge("first") },
          { key: "pagedown", cmd: () => props.store.selectEdge("last") },
          { key: "return", cmd: () => void toggleExpand() },
          { key: "space", cmd: () => void toggleExpand() },
        ]
      : [],
  }));

  async function toggleExpand() {
    const entry = props.store.toggleSelectedExpanded();
    if (!entry) return;

    if (entry.role === "thinking") {
      renderer.requestRender();
      return;
    }
    if (entry.role !== "tool") return;

    if (!(entry.expanded ?? false)) {
      renderer.requestRender();
      return;
    }

    if (entry.resultBody || !props.onExpand || !entry.sourceEventId) {
      renderer.requestRender();
      return;
    }

    props.store.setExpanding(entry.id, true);
    try {
      const result = await props.onExpand(entry);
      if (result.ok) {
        props.store.patchEntry(entry.id, { resultBody: result.text, expanded: true });
      } else {
        props.store.setEntryExpanded(entry.id, false);
      }
    } finally {
      props.store.setExpanding(entry.id, false);
      renderer.requestRender();
    }
  }

  return (
    // NOTE: no flexDirection prop here. OpenTUI 0.8.0 ScrollBox scrollbars are
    // native scene state, not Yoga children, so the root's flexDirection can
    // no longer collapse the vertical scrollbar track; the scrolled content
    // also always flows vertically regardless of flexDirection (verified
    // empirically with the test renderer: column vs default produce identical
    // frames). We keep the root at its default (no flexDirection prop) and
    // rely on native vertical content flow + full-height native scrollbar.
    <scrollbox
      id="transcript"
      flexGrow={1}
      minHeight={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      scrollY
      stickyScroll
      stickyStart="bottom"
    >
      <For each={props.store.entries}>
        {(entry, index) => {
          const prevRole =
            index() > 0 ? props.store.entries[index() - 1]?.role : undefined;
          const gap = needsGap(entry.role, prevRole);
          const streaming = () => props.store.streamingIds().has(entry.id);
          const selected = () =>
            props.store.focusMode() && props.store.selectedEntryId() === entry.id;

          return (
            <box id={`wrap-${entry.id}`} flexDirection="column" flexShrink={0}>
              <Show when={gap}>
                <box height={1} />
              </Show>
              <TranscriptEntryView
                entry={entry}
                opts={props.opts}
                streaming={streaming()}
                selected={selected()}
                width={dimensions().width || 80}
              />
            </box>
          );
        }}
      </For>
    </scrollbox>
  );
}

/** Imperative handle surface used by run.tsx (clear / load / focus). */
export type TranscriptHandle = TranscriptStoreApi;
