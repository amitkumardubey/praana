/** Axis-aligned rectangle in terminal cell coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createRect(
  x: number,
  y: number,
  width: number,
  height: number
): Rect {
  return { x, y, width, height };
}

export function rectArea(rect: Rect): Rect {
  return rect;
}

export function rectInner(rect: Rect, padding = 0): Rect {
  return {
    x: rect.x + padding,
    y: rect.y + padding,
    width: Math.max(0, rect.width - padding * 2),
    height: Math.max(0, rect.height - padding * 2),
  };
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.x &&
    x < rect.x + rect.width &&
    y >= rect.y &&
    y < rect.y + rect.height
  );
}
