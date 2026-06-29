import { cell, emptyCell, type Cell } from "./cell.js";
import type { Rect } from "./rect.js";
import { rectContains } from "./rect.js";
import type { Style } from "./style.js";
import { strWidth } from "./text.js";

/** 2D grid of terminal cells. */
export class Buffer {
  readonly width: number;
  readonly height: number;
  private readonly cells: Cell[];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = Array.from({ length: width * height }, () => emptyCell());
  }

  static fromSize(width: number, height: number): Buffer {
    return new Buffer(width, height);
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  get(x: number, y: number): Cell {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return emptyCell();
    }
    return this.cells[this.index(x, y)]!;
  }

  set(x: number, y: number, value: Cell): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.cells[this.index(x, y)] = value;
  }

  setChar(x: number, y: number, ch: string, style: Style = {}): void {
    this.set(x, y, cell(ch, style));
  }

  /** Write a string left-to-right; returns next x position. */
  setString(
    x: number,
    y: number,
    text: string,
    style: Style = {},
    maxWidth?: number
  ): number {
    let col = x;
    let used = 0;
    for (const ch of text) {
      const w = strWidth(ch);
      if (maxWidth !== undefined && used + w > maxWidth) break;
      if (col >= this.width || y >= this.height || y < 0) break;
      this.setChar(col, y, ch, style);
      if (w === 2 && col + 1 < this.width) {
        // Continuation cell: empty marker so the renderer skips it and lets the
        // terminal advance two columns for the wide glyph. A literal space here
        // would overwrite the glyph's right half (incremental diff) or shift the
        // rest of the row right by one column (full redraw).
        this.set(col + 1, y, cell("", style));
      }
      col += w;
      used += w;
    }
    return col;
  }

  /** Fill a rectangle with a character and style. */
  fill(rect: Rect, ch = " ", style: Style = {}): void {
    for (let dy = 0; dy < rect.height; dy++) {
      for (let dx = 0; dx < rect.width; dx++) {
        const x = rect.x + dx;
        const y = rect.y + dy;
        if (rectContains({ x: 0, y: 0, width: this.width, height: this.height }, x, y)) {
          this.setChar(x, y, ch, style);
        }
      }
    }
  }

  /** Copy region from another buffer. */
  merge(other: Buffer, x: number, y: number): void {
    for (let oy = 0; oy < other.height; oy++) {
      for (let ox = 0; ox < other.width; ox++) {
        const tx = x + ox;
        const ty = y + oy;
        if (tx >= 0 && ty >= 0 && tx < this.width && ty < this.height) {
          this.set(tx, ty, other.get(ox, oy));
        }
      }
    }
  }

  clone(): Buffer {
    const copy = new Buffer(this.width, this.height);
    for (let i = 0; i < this.cells.length; i++) {
      const c = this.cells[i]!;
      copy.cells[i] = { char: c.char, style: { ...c.style } };
    }
    return copy;
  }
}
