import type { Rect } from "../core/rect.js";
import { createRect } from "../core/rect.js";
import type { Constraint, Layout } from "./constraint.js";

/**
 * Split a rectangle according to layout constraints.
 * Returns child rectangles in order.
 */
export function splitLayout(layout: Layout, area: Rect): Rect[] {
  const { constraints, direction } = layout;
  const total = direction === "vertical" ? area.height : area.width;
  if (constraints.length === 0 || total <= 0) return [];

  const sizes = solveConstraints(constraints, total);
  const rects: Rect[] = [];
  let offset = direction === "vertical" ? area.y : area.x;

  for (const size of sizes) {
    if (direction === "vertical") {
      rects.push(createRect(area.x, offset, area.width, size));
      offset += size;
    } else {
      rects.push(createRect(offset, area.y, size, area.height));
      offset += size;
    }
  }
  return rects;
}

function solveConstraints(constraints: Constraint[], total: number): number[] {
  const n = constraints.length;
  const sizes = new Array<number>(n).fill(0);
  let remaining = total;
  const fillIndices: number[] = [];
  let fillWeight = 0;

  // First pass: fixed sizes
  for (let i = 0; i < n; i++) {
    const c = constraints[i]!;
    switch (c.kind) {
      case "length":
        sizes[i] = Math.min(c.value, remaining);
        remaining -= sizes[i]!;
        break;
      case "percentage": {
        const s = Math.floor((total * c.value) / 100);
        sizes[i] = Math.min(s, remaining);
        remaining -= sizes[i]!;
        break;
      }
      case "min":
        sizes[i] = Math.min(c.value, remaining);
        remaining -= sizes[i]!;
        break;
      case "max":
        sizes[i] = 0;
        break;
      case "ratio":
        fillIndices.push(i);
        break;
      case "fill":
        fillIndices.push(i);
        fillWeight += c.weight;
        break;
    }
  }

  // Distribute fill/ratio among remaining space
  if (fillIndices.length > 0 && remaining > 0) {
    const ratioTotal = fillIndices.reduce((sum, i) => {
      const c = constraints[i]!;
      if (c.kind === "ratio") return sum + c.numerator / c.denominator;
      if (c.kind === "fill") return sum + c.weight;
      return sum;
    }, 0);

    for (const i of fillIndices) {
      const c = constraints[i]!;
      let share = 0;
      if (c.kind === "ratio" && ratioTotal > 0) {
        share = Math.floor((remaining * (c.numerator / c.denominator)) / ratioTotal);
      } else if (c.kind === "fill" && fillWeight > 0) {
        share = Math.floor((remaining * c.weight) / fillWeight);
      }
      sizes[i] = share;
    }

    // Give leftover to last fill slot
    const used = sizes.reduce((a, b) => a + b, 0);
    const leftover = total - used;
    if (leftover > 0 && fillIndices.length > 0) {
      sizes[fillIndices[fillIndices.length - 1]!]! += leftover;
    }
  }

  // Apply max constraints
  for (let i = 0; i < n; i++) {
    const c = constraints[i]!;
    if (c.kind === "max" && sizes[i]! > c.value) {
      sizes[i] = c.value;
    }
  }

  return sizes;
}
