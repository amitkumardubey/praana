# Virtual Transcript Design

## Status

Approved for implementation planning.

## Problem

Long resumed sessions make the TUI sluggish because the current transcript
bootstrap hydrates every persisted `ui_transcript` row into a retained
`TranscriptContainer` component tree. In a representative session, that meant
roughly 934 components and 1.6 million characters, including large thinking
and tool-result bodies. The current #269 branch bounds the mounted data by
truncating and windowing it, but that makes historical transcript content
inaccessible in the normal UI and still clears and rebuilds container children
on structural updates.

The transcript must remain fully accessible while keeping active rendering work
bounded.

## Goals

- Keep typing responsive in resumed sessions with hundreds of transcript rows
  and megabytes of historical content.
- Preserve access to all historical transcript content through normal scrolling.
- Retain full thinking and tool-result data in the event log.
- Mount only viewport-adjacent complete turn groups, with a bounded overscan
  region.
- Preserve a user's scroll position while older history is paged in or a row is
  expanded.
- Follow new output only while the user is already at the transcript tail.
- Preserve current keyboard and mouse interaction behavior where possible.

## Non-goals

- Migrating the TUI framework to Rezi.
- Replacing `events.jsonl` as the canonical session record.
- Changing context-engine history, `search_session_log`, or transcript content
  semantics.
- Building a generalized terminal virtualization framework outside the
  transcript.

## Architecture

### Canonical transcript data

`events.jsonl` remains the full-fidelity source of truth. Resume creates a
lightweight transcript index rather than materializing every display body:

- transcript entry ID and turn group;
- role and compact display metadata;
- source event references for thinking and tool results;
- estimated collapsed and expanded row heights;
- expansion state, which is session-local UI state.

The index contains enough data to render compact rows. Large thinking text and
tool result bodies are resolved only when a user expands a matching row.

The current persistence-time truncation and normal resume entry/character
windowing introduced by the initial #269 fix are removed. A separate explicit,
user-visible safety response may be used only when an event log is malformed
or cannot be read; it must not silently discard valid historical content.

### Virtual transcript viewport

Introduce a transcript-specific virtual container over complete turn groups,
not individual rows. It owns:

- all indexed groups;
- the mounted group range;
- a configurable group/line overscan;
- tail-follow state;
- scroll anchor state;
- mounted row components keyed by transcript entry ID.

On resume, mount the newest viewport-sized range plus overscan. As the user
scrolls upward near the mounted range start, prepend an earlier page of complete
turn groups automatically. As the user scrolls downward near the mounted range
end after newer groups have been evicted, append the corresponding later page
from the index. Both directions use the configured older-history page size.
When new output arrives, append only newly created rows. When
the user scrolls away from the tail, later output does not alter their visible
position.

Prepending older groups and expanding/collapsing a row must retain the
user-visible anchor: the same already-visible entry remains at the same screen
position after the operation. Components leaving the overscan range are
unmounted and their heavy expanded bodies released.

### Row expansion

Thinking and tool rows render compactly by default. An explicit per-row
expand/collapse interaction retrieves full text by event reference:

- expanding resolves and formats the original event content;
- the row height is remeasured and the viewport is re-anchored;
- collapsing drops the mounted heavy body but retains the compact row and
  event reference;
- re-expansion retrieves the original content again.

Expansion must have keyboard bindings and support mouse activation. Existing
tool summaries remain visible without expansion.

### Live updates

`PiTuiSink` continues to update `TranscriptProjection`, but delegates to the
virtual transcript API:

- streamed assistant/thinking deltas patch an already-mounted tail row;
- tool completion patches its existing tool row;
- new structural entries append incrementally;
- historical range changes use explicit prepend/evict operations.

Ordinary live updates must not call `Container.clear()` or reconstruct the
mounted transcript range.

## Data Flow

1. Session resume reads the event log and constructs a lightweight indexed
   sequence of complete transcript groups.
2. The virtual transcript mounts the newest visible range and overscan.
3. Input, streaming text, and tool completions update the projection and then
   patch or append the equivalent mounted entry.
4. Upward scrolling near the mounted boundary loads an earlier group page,
   prepends it, and restores the prior visual anchor.
5. Expanding a tool or thinking row resolves its full event payload lazily,
   updates its measured height, and restores the anchor.
6. Leaving the viewport evicts non-visible components and expanded bodies while
   retaining their index metadata.

## Error Handling

- Missing or invalid event references render a compact error state on that row,
  with enough context to identify the unavailable event. The transcript remains
  scrollable.
- A failed lazy read must not erase the compact summary or invalidate adjacent
  rows.
- Unknown legacy event shapes retain existing projection fallback behavior.
- The system must avoid silent blank output: unavailable content is visibly
  reported rather than treated as an empty successful expansion.

## Configuration

Expose only controls needed for operational tuning:

- mounted-group overscan, in complete turn groups, default `5`;
- older-history page size, in complete turn groups, default `20`.

Do not expose normal-history clipping or payload-truncation settings. Defaults
are selected from the benchmark fixture and documented with their units. There
is no hard limit that clips valid transcript history. If indexing a malformed
or unreadable event log fails, resume reports the error visibly and preserves
the existing event-log recovery behavior rather than silently presenting a
partial transcript as complete.

## Testing and Benchmarks

Unit tests cover:

- grouping and indexing of persisted and legacy transcript events;
- latest-range resume mount;
- automatic upward paging at complete-turn boundaries;
- automatic downward re-append paging at complete-turn boundaries;
- anchor preservation for prepend, expansion, and collapse;
- tail-follow behavior;
- lazy full-content retrieval and explicit retrieval errors;
- bounded mounted component and expanded-body counts;
- incremental streaming and tool-result updates without container clearing.

Add a synthetic fixture with at least 900 transcript rows and megabyte-scale
thinking/tool data. Tests must prove every historical row can be reached while
the mounted tree remains within its configured bound.

Add a repeatable TUI benchmark/harness that captures render latency for:

- idle typing in a resumed large session;
- streaming at the tail;
- paging upward;
- expanding and collapsing a large result body.

On the project reference development machine at a 120x40 terminal, the
synthetic fixture must meet these p95 render-time targets:

- idle typing: at most 50 ms;
- tail streaming patch: at most 50 ms;
- upward page prepend: at most 100 ms;
- expanding or collapsing a large result body: at most 150 ms.

The harness records the machine/runtime metadata with each result. Acceptance
is behavioral and measured: historical transcript content remains reachable,
mounted tree size is bounded by the visible range plus five complete groups on
each side, and per-update work is independent of total session history.

## Deferred Rezi Evaluation

After the pi-tui implementation is stable, conduct a separate Rezi spike using
the same large-session fixture. It must include variable-height transcript
items, tail-following, scrolling, expansion/collapse, and the PRAANA editor.

Compare measured latency, feature parity, portability, dependency/runtime
constraints, and migration cost. This evaluation does not block the pi-tui
implementation or imply a framework migration.
