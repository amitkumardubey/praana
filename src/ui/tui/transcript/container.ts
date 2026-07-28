/**
 * Retained transcript tree — pi-style chat container.
 *
 * Semantic transcript entries render into real pi-tui Component children.
 * Streaming state is owned by TranscriptProjection; this class is only an adapter.
 */
import { Container, Spacer, type Component, type TUI } from "@earendil-works/pi-tui";
import { needsGap } from "./gap.js";
import type { IndexedTranscriptEntry, TranscriptGroup } from "./index.js";
import type { TranscriptEntry, ToolEntry } from "./model.js";
import type { TranscriptRenderOpts } from "./opts.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { RecallChipComponent } from "./components/recall-chip.js";
import { SystemLineComponent } from "./components/system-line.js";
import { ThinkingMessageComponent } from "./components/thinking-message.js";
import { ToolRowComponent } from "./components/tool-row.js";
import { TurnFooterComponent } from "./components/turn-footer.js";
import { UserMessageComponent } from "./components/user-message.js";

export interface VirtualTranscriptOpts {
  /** Complete turn groups rendered above and below the visible viewport. */
  overscanGroups: number;
  /** Complete turn groups loaded when scrolling near a boundary. */
  pageSizeGroups: number;
}

export class TranscriptContainer extends Container {
  private readonly tui: TUI;
  private readonly opts: TranscriptRenderOpts;
  private readonly virtualOpts: VirtualTranscriptOpts;
  /** All indexed transcript groups. */
  private groups: TranscriptGroup[] = [];
  /** Range of mounted group indices (exclusive end). */
  private mountedRange: { start: number; end: number } = { start: 0, end: 0 };
  /** Whether new tail output should auto-scroll. */
  private tailFollowing = true;
  /** Parallel array mapping each child to its source entry id (null for spacers). */
  private entryIds: (string | null)[] = [];

  constructor(
    tui: TUI,
    opts: TranscriptRenderOpts,
    virtualOpts?: Partial<VirtualTranscriptOpts>,
  ) {
    super();
    this.tui = tui;
    this.opts = opts;
    this.virtualOpts = {
      overscanGroups: virtualOpts?.overscanGroups ?? 5,
      pageSizeGroups: virtualOpts?.pageSizeGroups ?? 20,
    };
  }

  /** Load a full transcript index. Replaces any existing mounted content. */
  loadIndex(index: { groups: TranscriptGroup[] }): void {
    super.clear();
    this.entryIds = [];
    this.groups = index.groups;
    this.tailFollowing = true;
    this.mountedRange = {
      start: this.desiredResumeStart(),
      end: this.desiredResumeEnd(),
    };
    this.mountRange(this.mountedRange.start, this.mountedRange.end);
    this.requestRender();
  }

  clear(): void {
    super.clear();
    this.entryIds = [];
    this.groups = [];
    this.mountedRange = { start: 0, end: 0 };
    this.tailFollowing = true;
    this.requestRender();
  }

  /**
   * Render a full sequence of entries, reusing unchanged components when
   * possible instead of clearing and rebuilding the entire tree.
   * This is retained for compatibility with the projection-based sink path;
   * long-term callers should use the index-based API.
   */
  renderEntries(entries: TranscriptEntry[]): void {
    const oldById = new Map<string, Component>();
    for (let i = 0; i < this.entryIds.length; i++) {
      const id = this.entryIds[i];
      if (id) oldById.set(id, this.children[i]!);
    }

    super.clear();
    this.entryIds = [];

    let prev: TranscriptEntry | undefined;
    for (const entry of entries) {
      if (needsGap(entry.role, prev?.role)) {
        this.addChild(new Spacer(1));
        this.entryIds.push(null);
      }
      const existing = oldById.get(entry.id);
      if (existing && this.tryUpdateComponent(existing, entry)) {
        this.addChild(existing);
        this.entryIds.push(entry.id);
        if (entry.role === "turn_footer") {
          this.addChild(new Spacer(1));
          this.entryIds.push(null);
        }
      } else {
        this.mountFinalizedEntry(entry);
      }
      prev = entry;
    }
    this.requestRender();
  }

  /** Fast path for streaming assistant text. Returns false if no component exists. */
  appendAssistantDelta(id: string, delta: string): boolean {
    const loc = this.findEntryLocation(id);
    if (loc) {
      const entry = this.groups[loc.groupIndex]!.entries[loc.entryIndex]!;
      if (entry.role === "assistant") {
        entry.text += delta;
      }
    }
    const component = this.findEntryComponent(id);
    if (component instanceof AssistantMessageComponent) {
      component.appendDelta(delta);
      this.requestRender();
      return true;
    }
    return false;
  }

  /** Fast path for streaming thinking text. Returns false if no component exists. */
  appendThinkingDelta(id: string, delta: string): boolean {
    const loc = this.findEntryLocation(id);
    if (loc) {
      const entry = this.groups[loc.groupIndex]!.entries[loc.entryIndex]!;
      if (entry.role === "thinking") {
        entry.text += delta;
      }
    }
    const component = this.findEntryComponent(id);
    if (component instanceof ThinkingMessageComponent) {
      component.appendDelta(delta);
      this.requestRender();
      return true;
    }
    return false;
  }

  /** Fast path for patching a tool row when its result arrives. */
  patchToolResult(id: string, entry: ToolEntry): boolean {
    const loc = this.findEntryLocation(id);
    if (loc) {
      const stored = this.groups[loc.groupIndex]!.entries[loc.entryIndex]!;
      if (stored.role === "tool") {
        stored.resultSummary = entry.resultSummary;
        stored.resultBody = entry.resultBody;
        stored.resultText = entry.resultText;
        stored.isError = entry.isError;
      }
    }
    const component = this.findEntryComponent(id);
    if (component instanceof ToolRowComponent) {
      component.setResult({
        resultSummary: entry.resultSummary,
        resultBody: entry.resultBody,
        isError: entry.isError,
      });
      this.requestRender();
      return true;
    }
    return false;
  }

  /**
   * Append a single entry to the tail, or replace an existing entry with the
   * same id. Used for live updates and for back-filling entries whose
   * components are not currently mounted.
   */
  appendEntry(entry: IndexedTranscriptEntry): void {
    const existing = this.findEntryLocation(entry.id);
    if (existing) {
      this.groups[existing.groupIndex]!.entries[existing.entryIndex] = entry;
      // If the replaced entry is currently mounted, update its component.
      if (
        existing.groupIndex >= this.mountedRange.start &&
        existing.groupIndex < this.mountedRange.end
      ) {
        this.patchMountedEntry(entry);
      }
    } else {
      const group = this.groups[this.groups.length - 1];
      if (!group || group.group !== entry.group) {
        this.groups.push({ group: entry.group, entries: [entry] });
      } else {
        group.entries.push(entry);
      }
    }

    if (!this.tailFollowing) return;
    if (this.mountedRange.end < this.groups.length) {
      // Ensure the new tail group is mounted.
      this.mountedRange.end = this.groups.length;
      this.mountRange(this.mountedRange.start, this.mountedRange.end);
    } else if (!existing) {
      this.mountFinalizedEntry(entry);
    }
    this.trimHeadIfNeeded();
    this.requestRender();
  }

  private findEntryLocation(
    id: string,
  ): { groupIndex: number; entryIndex: number } | undefined {
    for (let g = 0; g < this.groups.length; g++) {
      const entries = this.groups[g]!.entries;
      for (let e = 0; e < entries.length; e++) {
        if (entries[e]!.id === id) return { groupIndex: g, entryIndex: e };
      }
    }
    return undefined;
  }

  private patchMountedEntry(entry: IndexedTranscriptEntry): void {
    const component = this.findEntryComponent(entry.id);
    if (!component) return;
    if (this.tryUpdateComponent(component, entry)) return;
    // Role mismatch: rebuild the single component in place. This is rare in
    // practice (ids are stable per role), so a full remount of the range is
    // acceptable as a fallback.
    this.mountRange(this.mountedRange.start, this.mountedRange.end);
  }

  /** Prepend earlier groups when scrolling upward near the mounted start. */
  prependPage(): void {
    const targetStart = Math.max(
      0,
      this.mountedRange.start - this.virtualOpts.pageSizeGroups,
    );
    if (targetStart === this.mountedRange.start) return;
    this.mountedRange = { start: targetStart, end: this.mountedRange.end };
    this.clampRangeFromTail();
    this.mountRange(this.mountedRange.start, this.mountedRange.end);
    this.requestRender();
  }

  /** Append later groups when scrolling downward after eviction. */
  appendPage(): void {
    const targetEnd = Math.min(
      this.groups.length,
      this.mountedRange.end + this.virtualOpts.pageSizeGroups,
    );
    if (targetEnd === this.mountedRange.end) return;
    this.mountedRange = { start: this.mountedRange.start, end: targetEnd };
    this.clampRangeFromHead();
    this.mountRange(this.mountedRange.start, this.mountedRange.end);
    this.requestRender();
  }

  /** Called by scroll input handlers when the viewport moves upward. */
  onScrollUp(): void {
    this.tailFollowing = false;
    if (this.mountedRange.start === 0) return;
    // Page in once the user is within one overscan group of the start.
    // Simplification: load the next page immediately on any upward scroll.
    this.prependPage();
  }

  /** Called by scroll input handlers when the viewport moves downward. */
  onScrollDown(): void {
    if (this.mountedRange.end >= this.groups.length) {
      // Already at the newest content; just re-enable tail-follow.
      this.tailFollowing = true;
      return;
    }
    this.appendPage();
    // Re-enable tail-follow if we are back at the newest content.
    if (this.mountedRange.end >= this.groups.length) {
      this.tailFollowing = true;
    }
  }

  getMountedGroupRange(): { start: number; end: number } {
    return { ...this.mountedRange };
  }

  getTotalGroups(): number {
    return this.groups.length;
  }

  // ─── Resume bootstrap ────────────────────────────────────────────────────

  private visibleGroupBudget(): number {
    // Heuristic: assume a typical terminal shows ~40 rows. A complete group
    // with user + assistant + tools rarely exceeds 20 rows, so two groups are
    // almost always visible. Add overscan on both sides.
    return 2 + this.virtualOpts.overscanGroups * 2;
  }

  private desiredResumeEnd(): number {
    return this.groups.length;
  }

  private desiredResumeStart(): number {
    return Math.max(0, this.desiredResumeEnd() - this.visibleGroupBudget());
  }

  private mountRange(start: number, end: number): void {
    super.clear();
    this.entryIds = [];
    let prev: IndexedTranscriptEntry | undefined;
    for (let i = start; i < end; i++) {
      for (const entry of this.groups[i]!.entries) {
        if (needsGap(entry.role, prev?.role)) {
          this.addChild(new Spacer(1));
          this.entryIds.push(null);
        }
        this.mountFinalizedEntry(entry);
        prev = entry;
      }
    }
  }

  private trimHeadIfNeeded(): void {
    const budget = this.visibleGroupBudget();
    if (this.mountedRange.end - this.mountedRange.start <= budget) return;
    this.mountedRange.start = Math.max(
      0,
      this.mountedRange.end - budget,
    );
  }

  private trimTailIfNeeded(): void {
    const budget = this.visibleGroupBudget();
    if (this.mountedRange.end - this.mountedRange.start <= budget) return;
    this.mountedRange.end = Math.min(
      this.groups.length,
      this.mountedRange.start + budget,
    );
  }

  private maxMountedGroups(): number {
    // Allow one extra page beyond the visible budget so a single scroll
    // does not immediately evict the anchor group.
    return this.visibleGroupBudget() + this.virtualOpts.pageSizeGroups;
  }

  /**
   * After prepending older groups, the viewport is anchored at the top.
   * If over budget, evict from the tail.
   */
  private clampRangeFromTail(): void {
    const maxGroups = this.maxMountedGroups();
    if (this.mountedRange.end - this.mountedRange.start <= maxGroups) return;
    this.mountedRange.end = Math.min(
      this.groups.length,
      this.mountedRange.start + maxGroups,
    );
  }

  /**
   * After appending newer groups, the viewport is anchored at the bottom.
   * If over budget, evict from the head.
   */
  private clampRangeFromHead(): void {
    const maxGroups = this.maxMountedGroups();
    if (this.mountedRange.end - this.mountedRange.start <= maxGroups) return;
    this.mountedRange.start = Math.max(
      0,
      this.mountedRange.end - maxGroups,
    );
  }

  private findEntryComponent(id: string): Component | undefined {
    const index = this.entryIds.indexOf(id);
    return index >= 0 ? this.children[index] : undefined;
  }

  private tryUpdateComponent(
    component: Component,
    entry: TranscriptEntry,
  ): boolean {
    switch (entry.role) {
      case "user": {
        if (!(component instanceof UserMessageComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
      case "assistant": {
        if (!(component instanceof AssistantMessageComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
      case "thinking": {
        if (!(component instanceof ThinkingMessageComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
      case "tool": {
        if (!(component instanceof ToolRowComponent)) return false;
        if (
          component.getResultSummary() !== entry.resultSummary ||
          component.getResultBody() !== entry.resultBody ||
          component.getIsError() !== entry.isError
        ) {
          component.setResult({
            resultSummary: entry.resultSummary,
            resultBody: entry.resultBody,
            isError: entry.isError,
          });
        }
        return true;
      }
      case "recall": {
        if (!(component instanceof RecallChipComponent)) return false;
        if (
          component.getPreview() !== entry.preview ||
          component.getCount() !== entry.count ||
          component.getQuery() !== (entry.query ?? null)
        ) {
          return false;
        }
        return true;
      }
      case "system": {
        if (!(component instanceof SystemLineComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
      case "turn_footer": {
        if (!(component instanceof TurnFooterComponent)) return false;
        if (component.getText() !== entry.text) component.setText(entry.text);
        return true;
      }
    }
  }

  private mountFinalizedEntry(entry: IndexedTranscriptEntry): void {
    switch (entry.role) {
      case "user":
        this.addChild(new UserMessageComponent(entry.text, this.opts));
        this.entryIds.push(entry.id);
        break;
      case "assistant":
        this.addChild(new AssistantMessageComponent(entry.text, this.opts));
        this.entryIds.push(entry.id);
        break;
      case "thinking": {
        const comp = new ThinkingMessageComponent(entry.text, this.opts);
        comp.setExpanded(false);
        comp.setDisplayedLines(2);
        this.addChild(comp);
        this.entryIds.push(entry.id);
        break;
      }
      case "tool": {
        const row = new ToolRowComponent(
          {
            toolName: entry.toolName,
            toolIcon: entry.toolIcon,
            toolLabel: entry.toolLabel,
            toolPending: entry.toolPending,
            resultSummary: entry.resultSummary,
            resultBody: entry.resultBody,
            isError: entry.isError,
            expandable: entry.expandable,
            expanded: false,
          },
          this.opts,
        );
        this.addChild(row);
        this.entryIds.push(entry.id);
        break;
      }
      case "recall":
        this.addChild(
          new RecallChipComponent(
            entry.preview,
            entry.count,
            entry.query ?? null,
            this.opts,
          ),
        );
        this.entryIds.push(entry.id);
        break;
      case "system":
        this.addChild(new SystemLineComponent(entry.text, this.opts));
        this.entryIds.push(entry.id);
        break;
      case "turn_footer":
        this.addChild(new TurnFooterComponent(entry.text));
        this.entryIds.push(entry.id);
        this.addChild(new Spacer(1));
        this.entryIds.push(null);
        break;
    }
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}
