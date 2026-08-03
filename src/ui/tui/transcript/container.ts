/**
 * Retained transcript tree — OpenTUI chat container.
 *
 * Semantic transcript entries render into real OpenTUI renderable children.
 * Streaming state is owned by TranscriptProjection; this class is only an adapter.
 */
import { ScrollBoxRenderable, BoxRenderable, type RenderContext, type Renderable } from "@opentui/core";
import { needsGap } from "./gap.js";
import type {
  ExpandedContentResult,
  IndexedTranscriptEntry,
  TranscriptGroup,
} from "./index.js";
import type { TranscriptEntry, ToolEntry, TranscriptRole } from "./model.js";
import type { TranscriptRenderOpts } from "./opts.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { RecallChipComponent } from "./components/recall-chip.js";
import { SystemLineComponent } from "./components/system-line.js";
import { ThinkingMessageComponent } from "./components/thinking-message.js";
import { ToolRowComponent } from "./components/tool-row.js";
import { TurnFooterComponent } from "./components/turn-footer.js";
import { UserMessageComponent } from "./components/user-message.js";

export interface TranscriptInteractionOpts {
  /** Resolve the full body for an expandable entry on demand. */
  onExpand?: (
    entry: IndexedTranscriptEntry,
  ) => Promise<ExpandedContentResult> | ExpandedContentResult;
  /** Called when the transcript wants to move focus elsewhere (e.g. blur). */
  onRequestFocus?: (target: unknown) => void;
}

export interface VirtualTranscriptOpts {
  /** Complete turn groups rendered above and below the visible viewport. */
  overscanGroups: number;
  /** Complete turn groups loaded when scrolling near a boundary. */
  pageSizeGroups: number;
}

export class TranscriptContainer extends ScrollBoxRenderable {
  private readonly opts: TranscriptRenderOpts;
  private readonly virtualOpts: VirtualTranscriptOpts;
  private readonly interaction: TranscriptInteractionOpts;
  /** All indexed transcript groups. */
  private groups: TranscriptGroup[] = [];
  /** Whether new tail output should auto-scroll. */
  private tailFollowing = true;
  /** Focus mode for transcript navigation. */
  focusMode = false;
  /** Currently selected entry id for focus-mode navigation. */
  private selectedEntryId: string | null = null;
  private expandingIds = new Set<string>();
  private lastRole: TranscriptRole | undefined;
  /** Maps entry id → renderable component for O(1) lookup. */
  private entryMap = new Map<string, Renderable>();

  get pendingExpansions(): ReadonlySet<string> {
    return this.expandingIds;
  }

  constructor(
    ctx: RenderContext,
    opts: TranscriptRenderOpts,
    virtualOpts?: Partial<VirtualTranscriptOpts>,
    interaction?: TranscriptInteractionOpts,
  ) {
    super(ctx, {
      id: "transcript",
      flexDirection: "column",
      scrollY: true,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    this.opts = opts;
    this.virtualOpts = {
      overscanGroups: virtualOpts?.overscanGroups ?? 5,
      pageSizeGroups: virtualOpts?.pageSizeGroups ?? 20,
    };
    this.interaction = interaction ?? {};
  }

  /** All mounted renderable children (entries + gap spacers). */
  get children(): Renderable[] {
    return this.getChildren();
  }

  /** Load a full transcript index. Replaces any existing mounted content. */
  loadIndex(index: { groups: TranscriptGroup[] }): void {
    this.clear();
    this.groups = index.groups;
    this.tailFollowing = true;
    this.lastRole = undefined;
    for (const group of this.groups) {
      for (const entry of group.entries) {
        this.mountEntry(entry);
      }
    }
    this.requestRender();
  }

  clear(): void {
    for (const child of this.getChildren()) {
      this.remove(child);
    }
    this.entryMap.clear();
    this.groups = [];
    this.tailFollowing = true;
    this.selectedEntryId = null;
    this.expandingIds.clear();
    this.lastRole = undefined;
    this.requestRender();
  }

  /** Toggle transcript focus mode. When focused, arrow keys navigate rows. */
  setFocused(focused: boolean): void {
    this.focusMode = focused;
    if (focused && !this.selectedEntryId) {
      this.selectLastEntry();
    }
    this.requestRender();
  }

  /** Keyboard navigation when the transcript has focus. */
  handleInput(data: string): void {
    if (data === "\x1b" || data === "\x1b\x1b") {
      this.setFocused(false);
      this.interaction.onRequestFocus?.(null);
      return;
    }
    if (data === "\x1b[A" || data === "\x1bOA") {
      this.selectPreviousEntry();
      return;
    }
    if (data === "\x1b[B" || data === "\x1bOB") {
      this.selectNextEntry();
      return;
    }
    if (data === "\x1b[5~" || data === "\x1b[5;2~") {
      this.onScrollUp();
      this.selectFirstMountedEntry();
      return;
    }
    if (data === "\x1b[6~" || data === "\x1b[6;2~") {
      this.onScrollDown();
      this.selectLastMountedEntry();
      return;
    }
    if (data === "\r" || data === "\n" || data === " ") {
      void this.toggleSelectedEntry();
    }
  }

  /**
   * Render a full sequence of entries, reusing unchanged components when
   * possible instead of clearing and rebuilding the entire tree.
   * This is retained for compatibility with the projection-based sink path;
   * long-term callers should use the index-based API.
   */
  renderEntries(entries: TranscriptEntry[]): void {
    for (const child of this.getChildren()) {
      this.remove(child);
    }
    this.entryMap.clear();
    this.lastRole = undefined;

    let prev: TranscriptEntry | undefined;
    for (const entry of entries) {
      if (needsGap(entry.role, prev?.role)) {
        this.add(new BoxRenderable(this.ctx, { id: "transcript-gap", height: 1 }));
      }
      this.mountFinalizedEntry(entry);
      prev = entry;
    }
    this.requestRender();
  }

  /** Fast path for streaming assistant text. Returns false if no component exists. */
  appendAssistantDelta(id: string, delta: string): boolean {
    const component = this.entryMap.get(id);
    if (component instanceof AssistantMessageComponent) {
      component.appendDelta(delta);
      this.requestRender();
      return true;
    }
    const entry = this.findEntryById(id);
    if (entry && entry.role === "assistant") {
      entry.text += delta;
    }
    return false;
  }

  /** Fast path for streaming thinking text. Returns false if no component exists. */
  appendThinkingDelta(id: string, delta: string): boolean {
    const component = this.entryMap.get(id);
    if (component instanceof ThinkingMessageComponent) {
      component.appendDelta(delta);
      this.requestRender();
      return true;
    }
    const entry = this.findEntryById(id);
    if (entry && entry.role === "thinking") {
      entry.text += delta;
    }
    return false;
  }

  /** Fast path for patching a tool row when its result arrives. */
  patchToolResult(id: string, entry: ToolEntry): boolean {
    const component = this.entryMap.get(id);
    if (component instanceof ToolRowComponent) {
      component.setResult({
        resultSummary: entry.resultSummary,
        resultBody: entry.resultBody,
        isError: entry.isError,
      });
      const stored = this.findEntryById(id);
      if (stored && stored.role === "tool") {
        stored.resultSummary = entry.resultSummary;
        stored.resultBody = entry.resultBody;
        stored.resultText = entry.resultText;
        stored.isError = entry.isError;
      }
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
      this.patchMountedEntry(entry);
    } else {
      const group = this.groups[this.groups.length - 1];
      if (!group || group.group !== entry.group) {
        this.groups.push({ group: entry.group, entries: [entry] });
      } else {
        group.entries.push(entry);
      }
    }

    if (!this.tailFollowing) return;
    this.mountFinalizedEntry(entry);
    this.scrollTo({ x: 0, y: this.scrollHeight });
    this.requestRender();
  }

  /** Prepend earlier groups when scrolling upward near the mounted start. */
  prependPage(): void {
    // No-op under OpenTUI — all entries are direct children; ScrollBoxRenderable handles scrolling.
  }

  /** Append later groups when scrolling downward after eviction. */
  appendPage(): void {
    // No-op under OpenTUI.
  }

  /** Called by scroll input handlers when the viewport moves upward. */
  onScrollUp(): void {
    this.tailFollowing = false;
    this.scrollBy(-1);
  }

  /** Called by scroll input handlers when the viewport moves downward. */
  onScrollDown(): void {
    this.scrollBy(1);
    this.tailFollowing = true;
  }

  getMountedGroupRange(): { start: number; end: number } {
    return { start: 0, end: this.groups.length };
  }

  getTotalGroups(): number {
    return this.groups.length;
  }

  /** True if the given entry is currently expanded (only tool/thinking rows). */
  isRowExpanded(id: string): boolean {
    const component = this.entryMap.get(id);
    if (component instanceof ThinkingMessageComponent) {
      return component.isExpanded();
    }
    if (component instanceof ToolRowComponent) {
      return component.isExpanded();
    }
    return false;
  }

  // ─── Focus-mode selection helpers ────────────────────────────────────────

  private selectLastEntry(): void {
    const children = this.getChildren();
    for (let i = children.length - 1; i >= 0; i--) {
      const id = this.entryIdForChild(children[i]!);
      if (id) {
        this.selectedEntryId = id;
        return;
      }
    }
    this.selectedEntryId = null;
  }

  private selectFirstMountedEntry(): void {
    const children = this.getChildren();
    for (let i = 0; i < children.length; i++) {
      const id = this.entryIdForChild(children[i]!);
      if (id) {
        this.selectedEntryId = id;
        return;
      }
    }
    this.selectedEntryId = null;
  }

  private selectLastMountedEntry(): void {
    this.selectLastEntry();
  }

  private selectPreviousEntry(): void {
    const children = this.getChildren();
    const start = this.selectedChildIndex();
    for (let i = start - 1; i >= 0; i--) {
      const id = this.entryIdForChild(children[i]!);
      if (id) {
        this.selectedEntryId = id;
        this.requestRender();
        return;
      }
    }
  }

  private selectNextEntry(): void {
    const children = this.getChildren();
    const start = this.selectedChildIndex();
    for (let i = start + 1; i < children.length; i++) {
      const id = this.entryIdForChild(children[i]!);
      if (id) {
        this.selectedEntryId = id;
        this.requestRender();
        return;
      }
    }
  }

  private selectedChildIndex(): number {
    if (!this.selectedEntryId) return -1;
    const children = this.getChildren();
    for (let i = 0; i < children.length; i++) {
      if (this.entryIdForChild(children[i]!) === this.selectedEntryId) return i;
    }
    return -1;
  }

  private async toggleSelectedEntry(): Promise<void> {
    if (!this.selectedEntryId) return;
    const entry = this.findEntryById(this.selectedEntryId);
    if (!entry) return;
    if (entry.role !== "thinking" && entry.role !== "tool") return;
    if (!entry.expandable) return;

    const expanding = !(entry.expanded ?? false);
    entry.expanded = expanding;

    if (entry.role === "thinking") {
      const component = this.entryMap.get(entry.id);
      if (component instanceof ThinkingMessageComponent) {
        component.setExpanded(expanding);
      }
      this.requestRender();
      return;
    }

    if (!expanding) {
      const component = this.entryMap.get(entry.id);
      if (component instanceof ToolRowComponent) {
        component.setExpanded(false);
      }
      this.requestRender();
      return;
    }

    if (entry.resultBody || !this.interaction.onExpand || !entry.sourceEventId) {
      const component = this.entryMap.get(entry.id);
      if (component instanceof ToolRowComponent) {
        component.setExpanded(true);
      }
      this.requestRender();
      return;
    }

    this.expandingIds.add(entry.id);
    this.requestRender();
    const result = await this.interaction.onExpand(entry);
    this.expandingIds.delete(entry.id);
    if (result.ok) {
      entry.resultBody = result.text;
    } else {
      entry.resultBody = `[expand failed: ${result.error}]`;
      entry.isError = true;
    }
    const component = this.entryMap.get(entry.id);
    if (component instanceof ToolRowComponent) {
      component.setResult({
        resultBody: entry.resultBody,
        isError: entry.isError,
        expanded: true,
      });
    }
    this.requestRender();
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private mountEntry(entry: IndexedTranscriptEntry): void {
    if (needsGap(entry.role, this.lastRole)) {
      this.add(new BoxRenderable(this.ctx, { id: "transcript-gap", height: 1 }));
    }
    this.lastRole = entry.role;
    this.mountFinalizedEntry(entry);
  }

  private mountFinalizedEntry(entry: IndexedTranscriptEntry): void {
    switch (entry.role) {
      case "user": {
        const comp = new UserMessageComponent(this.ctx, entry.text, this.opts);
        this.add(comp);
        this.entryMap.set(entry.id, comp);
        break;
      }
      case "assistant": {
        const comp = new AssistantMessageComponent(this.ctx, entry.text, this.opts);
        this.add(comp);
        this.entryMap.set(entry.id, comp);
        break;
      }
      case "thinking": {
        const comp = new ThinkingMessageComponent(this.ctx, entry.text, this.opts);
        comp.setExpanded(entry.expanded ?? false);
        comp.setDisplayedLines(2);
        this.add(comp);
        this.entryMap.set(entry.id, comp);
        break;
      }
      case "tool": {
        const comp = new ToolRowComponent(
          this.ctx,
          {
            toolName: entry.toolName,
            toolIcon: entry.toolIcon,
            toolLabel: entry.toolLabel,
            toolPending: entry.toolPending,
            resultSummary: entry.resultSummary,
            resultBody: entry.resultBody,
            isError: entry.isError,
            expandable: entry.expandable,
            expanded: entry.expanded ?? false,
          },
          this.opts,
        );
        this.add(comp);
        this.entryMap.set(entry.id, comp);
        break;
      }
      case "recall": {
        const comp = new RecallChipComponent(
          this.ctx,
          entry.preview,
          entry.count,
          entry.query ?? null,
          this.opts,
        );
        this.add(comp);
        this.entryMap.set(entry.id, comp);
        break;
      }
      case "system": {
        const comp = new SystemLineComponent(this.ctx, entry.text, this.opts);
        this.add(comp);
        this.entryMap.set(entry.id, comp);
        break;
      }
      case "turn_footer": {
        const comp = new TurnFooterComponent(this.ctx, entry.text);
        this.add(comp);
        this.entryMap.set(entry.id, comp);
        this.add(new BoxRenderable(this.ctx, { id: "transcript-gap", height: 1 }));
        break;
      }
    }
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

  private findEntryById(id: string): IndexedTranscriptEntry | undefined {
    for (const group of this.groups) {
      for (const entry of group.entries) {
        if (entry.id === id) return entry;
      }
    }
    return undefined;
  }

  private patchMountedEntry(entry: IndexedTranscriptEntry): void {
    const component = this.entryMap.get(entry.id);
    if (!component) return;
    if (this.tryUpdateComponent(component, entry)) return;
    // Role mismatch: rebuild the single component in place.
    this.remove(component);
    this.mountFinalizedEntry(entry);
  }

  private tryUpdateComponent(
    component: Renderable,
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

  private entryIdForChild(child: Renderable): string | null {
    for (const [id, comp] of this.entryMap) {
      if (comp === child) return id;
    }
    return null;
  }
}