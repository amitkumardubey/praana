# Virtual Transcript Implementation Plan

> **For implementation:** Follow this plan step by step on
> `fix/issue-269-tui-typing-lag`. This supersedes the initial windowing and
> persistence-compaction implementation in commit `a4bdad2`.

## Goal

Make long resumed sessions responsive without removing historical transcript
content from normal scrolling. The TUI mounts a bounded viewport of complete
turn groups and lazily resolves full tool/thinking content from `events.jsonl`.

## Constraints

- Keep pi-tui; do not migrate to Rezi in this work.
- `events.jsonl` remains the full-fidelity source of truth.
- Valid history is never silently truncated.
- Normal live updates must not call `Container.clear()`.
- Preserve the user’s visual anchor when paging or changing expanded height.
- All validation uses Bun’s existing test runner and typecheck command.

## Phase 1: Replace lossy #269 persistence and resume behavior

### 1. Remove normal transcript clipping

**Files**
- Modify `src/types.ts`
- Modify `src/config.ts`
- Modify `src/app-controller.ts`
- Modify `src/ui/tui/run.ts`
- Modify `src/ui/tui/sink.ts`
- Modify `src/ui/tui/transcript/model.ts`
- Modify `tests/transcript-model.test.ts`
- Modify `tests/pi-tui-sink.test.ts`

**Steps**
1. Delete the normal-history settings:
   - `ui.transcript_resume_max_entries`
   - `ui.transcript_resume_max_chars`
   - `ui.transcript_persist_thinking_max_chars`
   - `ui.transcript_persist_tool_body_max_chars`
2. Remove their default values and validation from `src/config.ts`.
3. Remove `compactTranscriptEntry`, `TranscriptCompactionOpts`, and
   `windowTranscriptEntries` from `model.ts`.
4. Restore `buildTranscriptFromEvents()` as a full index/replay builder; it
   must not use an entry or character clip.
5. Remove `persistCompaction` from `SinkOpts`, `run.ts`, and `PiTuiSink`.
6. Keep existing compatibility replay of legacy events.
7. Remove tests that assert normal truncation and add coverage asserting full
   persisted entries remain indexable.

**Checkpoint**
- A long thinking/tool event is retained in the event log unchanged.
- Resume data construction retains references to it without eagerly mounting
  its full body.

## Phase 2: Define indexed transcript groups and full-content references

### 2. Add a lightweight transcript index

**Files**
- Modify `src/ui/tui/transcript/model.ts`
- Modify `src/ui/tui/transcript/events.ts`
- Add `src/ui/tui/transcript/index.ts`
- Modify `src/app-controller.ts`
- Add `tests/transcript-index.test.ts`

**Steps**
1. Define `TranscriptGroup` with a stable group number, ordered compact entries,
   and height metadata.
2. Define entry detail references:
   - tool entries reference their matching `tool_result` event;
   - thinking entries reference the persisted `ui_transcript` entry or another
     lossless event source when available.
3. Build `TranscriptIndex` from `eventsAfterResetBoundary()`:
   - prefer persisted `ui_transcript` compact rows for display ordering;
   - preserve source event IDs while processing the full event sequence;
   - fall back to the existing `TranscriptProjection` legacy replay when no
     persisted transcript rows exist.
4. Expose:
   - total group count;
   - group-range lookup;
   - an initial tail range;
   - `resolveExpandedContent(entryId)` returning full formatted content or an
     explicit unavailable-content error.
5. Change `StartupInfo.transcriptBootstrap` to carry the index (or an
   equivalent index-backed bootstrap contract) instead of an all-entry list.

**Tests**
- persisted and legacy sessions produce ordered complete groups;
- tools map to the right result when calls finish out of order;
- full payload resolution retrieves original content;
- missing/malformed references produce a visible error result, never an empty
  successful result.

## Phase 3: Create virtual transcript mounting and navigation

### 3. Replace retained-all `TranscriptContainer` behavior

**Files**
- Replace or substantially refactor `src/ui/tui/transcript/container.ts`
- Add `src/ui/tui/transcript/virtual-range.ts`
- Add `src/ui/tui/transcript/scroll-anchor.ts`
- Modify `src/ui/tui/run.ts`
- Modify `tests/transcript-container.test.ts`
- Add `tests/virtual-transcript.test.ts`

**Steps**
1. Implement `VirtualTranscriptContainer` around complete groups, maintaining:
   - all indexed groups;
   - `[mountedStart, mountedEnd)` group range;
   - a default overscan of five complete groups above and below;
   - mounted entry-ID-to-component lookup;
   - tail-follow state;
   - anchor entry ID and visual offset.
2. On resume, mount the tail-visible group range plus five groups of overscan.
3. Provide range operations:
   - `prependPage()` loads 20 earlier groups;
   - `appendPage()` loads 20 later groups after they were evicted;
   - `evictOutsideViewport()` removes groups outside visible range plus
     overscan;
   - `appendLiveGroup()` / `appendLiveEntry()` for new output.
4. Detect scrolling near either mounted boundary:
   - at the start, automatically page earlier groups;
   - at the end, automatically re-append later indexed groups;
   - use the same 20-group page size in both directions.
5. Capture and restore the anchor around prepend, append, eviction, and any
   height-changing operation.
6. Tail-follow stays enabled only at the tail. Any upward scroll disables it;
   returning to the tail re-enables it.
7. Do not call `super.clear()` for normal append, paging, patch, or eviction.
   Use `addChild`/`removeChild` and explicit component maps. Reserve full reset
   for `/clear` or index replacement.

**Tests**
- mounted group count remains bounded as a 900-row index is traversed;
- upward and downward paging reaches every group;
- no page splits a turn group;
- prepend, re-append, and eviction preserve the anchor;
- tail-follow does not disrupt users reading older history;
- normal updates do not call `clear()`.

## Phase 4: Lazy row expansion

### 4. Add explicit tool and thinking detail interactions

**Files**
- Modify `src/ui/tui/transcript/components/tool-row.ts`
- Modify `src/ui/tui/transcript/components/thinking-message.ts`
- Add `src/ui/tui/transcript/components/expandable-entry.ts` if shared behavior
  is justified
- Modify `src/ui/tui/transcript/container.ts`
- Modify `src/ui/tui/run.ts`
- Modify relevant keybinding/input routing
- Add `tests/transcript-expansion.test.ts`

**Steps**
1. Keep compact summaries as the default mounted representation.
2. Add keyboard and mouse activation for an expanded/collapsed state.
3. On expansion:
   - resolve full content from `TranscriptIndex`;
   - render the expanded body;
   - measure/reconcile row height;
   - restore the visible anchor.
4. On collapse:
   - release the expanded body;
   - keep compact metadata and reference;
   - restore the visible anchor.
5. When resolution fails, display a specific inline unavailable-content state,
   retaining the original compact summary.
6. Eviction must release expanded content, even if expansion state is retained
   as lightweight metadata for later remounting.

**Tests**
- expand/collapse tool and thinking rows;
- re-expand after eviction;
- content-error presentation;
- anchor preservation when a large body changes height;
- keyboard and mouse routes select the intended row.

## Phase 5: Rewire the live sink

### 5. Route projection updates to virtual operations

**Files**
- Modify `src/ui/tui/sink.ts`
- Modify `src/ui/tui/transcript/projection.ts` only if it needs index-safe
  incremental snapshots
- Modify `tests/pi-tui-sink.test.ts`

**Steps**
1. Replace `renderEntries(projection.entries())` in normal sink paths.
2. Route assistant/thinking deltas to mounted tail-row patch operations.
3. Route tool completions to in-place matching row patches.
4. Route newly created user/tool/system/footer rows to append operations.
5. Update the virtual index for finalized assistant/thinking rows before
   persistence.
6. Keep persistence lossless for transcript content and preserve legacy event
   behavior.
7. Handle a patch to an unmounted historical row by updating index metadata
   without mounting it.

**Tests**
- streaming and tool completion patch existing rows;
- no normal sink event clears/rebuilds the container;
- live tail remains visible only when tail-follow is enabled;
- persistence retains full thinking/tool content.

## Phase 6: Add fixture and performance harness

### 6. Prove bounded work and responsiveness

**Files**
- Add `tests/fixtures/large-transcript-events.jsonl`
- Add `tests/virtual-transcript-performance.test.ts`
- Add a small benchmark helper under `scripts/` or the existing benchmark/test
  location, following repository conventions
- Update `docs/ARCHITECTURE.md` only if it documents the transcript lifecycle

**Steps**
1. Generate/check in a deterministic fixture with at least 900 transcript rows
   and megabyte-scale thinking/tool payloads.
2. Add tests proving:
   - all history remains reachable;
   - only viewport plus five-group overscan is mounted;
   - expanded payloads are released on eviction.
3. Add a repeatable benchmark that records environment metadata and p95 render
   timing at 120x40 for:
   - idle typing in resumed history;
   - streamed tail patch;
   - upward paging;
   - large-body expand/collapse.
4. Enforce these reference-machine p95 targets:
   - typing: <=50 ms;
   - tail patch: <=50 ms;
   - page prepend: <=100 ms;
   - expansion/collapse: <=150 ms.

## Phase 7: Full validation and cleanup

### 7. Validate behavior end to end

**Commands**

```bash
bun typecheck
bun test tests/transcript-index.test.ts tests/virtual-transcript.test.ts tests/transcript-expansion.test.ts tests/pi-tui-sink.test.ts
bun test
```

**Manual TTY checks**

1. Resume the large fixture/session and type repeatedly at the prompt.
2. Scroll from the tail to the oldest group and back; verify automatic paging,
   continuity, and no jumps.
3. Expand and collapse large tool and thinking rows at different positions.
4. Start a live turn while reading historical content; verify new output does
   not steal focus or move the viewport until tail-follow is restored.
5. Run `/clear`, resume, and legacy-log replay checks.

## Deferred Follow-up: Rezi spike

Do not include this in the #269 implementation. After Phase 7, create a
separate issue/branch to implement the large fixture in Rezi `VirtualList` with
variable-height rows, tail-follow, detail expansion, and the PRAANA editor.
Compare the same benchmark metrics, feature parity, portability, and migration
cost before considering framework migration.
