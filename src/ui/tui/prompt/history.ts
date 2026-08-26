/**
 * Session prompt history ring buffer (Up/Down browsing).
 */
const DEFAULT_CAPACITY = 100;

export class PromptHistory {
  private readonly entries: string[] = [];
  private readonly capacity: number;
  private index = -1; // -1 = live draft (not browsing)
  private draft = "";

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  push(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.entries[this.entries.length - 1] === trimmed) {
      this.resetBrowse();
      return;
    }
    this.entries.push(trimmed);
    if (this.entries.length > this.capacity) {
      this.entries.shift();
    }
    this.resetBrowse();
  }

  /** Begin/continue browsing older entries. Returns text to show, or null if none. */
  up(currentDraft: string): string | null {
    if (this.entries.length === 0) return null;
    if (this.index < 0) {
      this.draft = currentDraft;
      this.index = this.entries.length - 1;
      return this.entries[this.index] ?? null;
    }
    if (this.index === 0) return this.entries[0] ?? null;
    this.index -= 1;
    return this.entries[this.index] ?? null;
  }

  /** Browse newer entries, or restore the live draft. */
  down(): string | null {
    if (this.index < 0) return null;
    if (this.index >= this.entries.length - 1) {
      this.index = -1;
      const draft = this.draft;
      this.draft = "";
      return draft;
    }
    this.index += 1;
    return this.entries[this.index] ?? null;
  }

  isBrowsing(): boolean {
    return this.index >= 0;
  }

  resetBrowse(): void {
    this.index = -1;
    this.draft = "";
  }

  size(): number {
    return this.entries.length;
  }
}
