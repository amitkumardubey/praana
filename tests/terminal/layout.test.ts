import { describe, it, expect } from "bun:test";
import {
  createLayout,
  fillConstraint,
  lengthConstraint,
} from "../../src/terminal/layout/constraint.js";
import { splitLayout } from "../../src/terminal/layout/split.js";
import { createRect } from "../../src/terminal/core/rect.js";

describe("splitLayout", () => {
  it("should split vertically by length and fill", () => {
    const layout = createLayout([
      lengthConstraint(3),
      fillConstraint(1),
    ]);
    const area = createRect(0, 0, 40, 10);
    const rects = splitLayout(layout, area);
    expect(rects).toHaveLength(2);
    expect(rects[0]!.height).toBe(3);
    expect(rects[1]!.height).toBe(7);
    expect(rects[0]!.width).toBe(40);
  });

  it("should split horizontally", () => {
    const layout = createLayout(
      [lengthConstraint(10), fillConstraint(1)],
      { direction: "horizontal" }
    );
    const rects = splitLayout(layout, createRect(0, 0, 30, 5));
    expect(rects[0]!.width).toBe(10);
    expect(rects[1]!.width).toBe(20);
  });
});
