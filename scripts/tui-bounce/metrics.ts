import { TextAttributes, type CapturedLine } from "@opentui/core";

/**
 * Fixture-scoped detector: these fixtures never use literal markdown syntax in
 * prose/code. Inspect painted spans, not source (or offscreen renderables).
 * OpenTUI 0.8 keeps '-' as its styled bullet, so distinguish that DIM span
 * from a plain source marker. Ordered list numbers are intentionally retained.
 */
export function rawSyntaxLines(lines: CapturedLine[]): string[] {
  return lines.flatMap(({ spans }) => {
    const text = spans.map((span) => span.text).join("");
    const marker = text.match(/^\s*[-*]\s+/);
    let rawList = false;
    if (marker) {
      const column = text.search(/\S/);
      let offset = 0;
      for (const span of spans) {
        if (offset <= column && column < offset + span.text.length) {
          rawList = (span.attributes & TextAttributes.DIM) === 0;
          break;
        }
        offset += span.text.length;
      }
    }
    return rawList || /^\s*#{1,6}(?:\s|$)/.test(text) || /\*\*|`|\|\s*:?-{3,}/.test(text)
      ? [text.trimEnd()]
      : [];
  });
}

/** One presented frame of the transcript viewport. */
export interface BounceFrame {
  scrollTop: number;
  scrollHeight: number;
  /** Markdown renderable height, 0 when the frame has no markdown node. */
  markdownHeight: number;
  /** First non-blank row in the viewport. */
  first: string;
  /** Last non-blank row in the viewport. */
  last: string;
  /** Full viewport text, row trailing spaces removed, blank rows kept. */
  text: string;
  sourceTail: string;
  rawSyntax: string[];
}

export interface BounceMetrics {
  /**
   * Direction reversals of a one-row shift of the viewport while the source
   * only grows. A shift is the whole visible block moving up or down by one
   * row (not a marker being concealed on an otherwise stable row).
   */
  bounce: number;
  /** Direction reversals of the scroll offset. */
  scrollReversals: number;
  /** Direction reversals of the last non-blank viewport row. */
  lastRowReversals: number;
  /** Immediate reversals of the first visible line (A → B → A). */
  topLineReversals: number;
  /** Frames whose viewport text returns to the text from two frames earlier. */
  undone: number;
  /** Largest scroll-offset decrease between consecutive frames. 0 if none. */
  minScrollDelta: number;
  /** Frames where the scroll content got shorter while the source grew. */
  heightShrinks: number;
  /** Frames where the markdown renderable got shorter. */
  markdownShrinks: number;
  /** Captured frames containing at least one visible, unconcealed marker. */
  rawSyntaxFrames: number;
  rawSyntaxExamples: string[];
  examples: string[];
}

const SCROLL_EPSILON = 0.5;

export function visibleOf(frame: string): { text: string; first: string; last: string } {
  const lines = frame.split("\n").map((line) => line.trimEnd());
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  let first = "";
  let last = "";
  for (const line of lines) {
    if (line.trim().length > 0) {
      first = line.trim();
      break;
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed.length > 0) {
      last = trimmed;
      break;
    }
  }
  return { text: lines.join("\n"), first, last };
}

function signOf(delta: number): number {
  if (Math.abs(delta) < SCROLL_EPSILON) return 0;
  return Math.sign(delta);
}

function contentRows(text: string): string[] {
  return text.split("\n").map((line) => line.trim());
}

function lastContentRow(text: string): number {
  const lines = contentRows(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.length > 0) return i;
  }
  return -1;
}

/**
 * +1 when the visible block moved up one row, -1 when it moved down one row.
 * Requires most non-blank rows to agree, so a concealed marker on one row
 * does not count.
 */
export function rowShift(prev: string, next: string): number {
  const a = contentRows(prev);
  const b = contentRows(next);
  const n = Math.min(a.length, b.length);
  if (n < 4) return 0;
  const score = (delta: number): number => {
    let same = 0;
    let compared = 0;
    for (let i = 1; i < n - 1; i++) {
      const j = i + delta;
      if (j < 0 || j >= n) continue;
      const left = a[i]!;
      const right = b[j]!;
      if (!left || !right) continue;
      compared++;
      if (left === right) same++;
    }
    return compared >= 4 ? same / compared : 0;
  };
  // score(-1): the row's text is now one row higher, so the block moved up.
  const movedUp = score(-1);
  const movedDown = score(1);
  const stay = score(0);
  if (movedUp >= 0.65 && movedUp > stay && movedUp > movedDown) return 1;
  if (movedDown >= 0.65 && movedDown > stay && movedDown > movedUp) return -1;
  return 0;
}

/**
 * Bounce: the visible block moves up and then down, or the reverse, across
 * presented frames. Scroll reversals are reported separately. Flat frames are
 * skipped so a held frame is not a reversal. Undone: viewport text matches
 * the frame before last after changing.
 */
export function measureBounce(frames: BounceFrame[]): BounceMetrics {
  let bounce = 0;
  let prevShift = 0;
  const examples: string[] = [];
  for (let i = 1; i < frames.length; i++) {
    const shift = rowShift(frames[i - 1]!.text, frames[i]!.text);
    if (shift === 0) continue;
    if (prevShift !== 0 && shift !== prevShift) {
      bounce++;
      if (examples.length < 8) {
        const before = frames[i - 1]!;
        const now = frames[i]!;
        examples.push(
          `shift ${shift > 0 ? "up" : "down"} after ${prevShift > 0 ? "up" : "down"} scroll ${before.scrollTop}→${now.scrollTop} height ${before.scrollHeight}→${now.scrollHeight} last ${JSON.stringify(before.last)}→${JSON.stringify(now.last)} tail ${JSON.stringify(now.sourceTail)}`,
        );
      }
    }
    prevShift = shift;
  }

  let scrollReversals = 0;
  let prevScroll = 0;
  let minScrollDelta = 0;
  let heightShrinks = 0;
  let markdownShrinks = 0;
  for (let i = 1; i < frames.length; i++) {
    const delta = frames[i]!.scrollTop - frames[i - 1]!.scrollTop;
    if (frames[i]!.scrollHeight < frames[i - 1]!.scrollHeight) heightShrinks++;
    if (frames[i]!.markdownHeight < frames[i - 1]!.markdownHeight) markdownShrinks++;
    if (delta < minScrollDelta) minScrollDelta = delta;
    const sign = signOf(delta);
    if (sign === 0) continue;
    if (prevScroll !== 0 && sign !== prevScroll) {
      scrollReversals++;
      if (examples.length < 8) {
        const before = frames[i - 1]!;
        const now = frames[i]!;
        examples.push(
          `scroll ${before.scrollTop}→${now.scrollTop} height ${before.scrollHeight}→${now.scrollHeight} first ${JSON.stringify(before.first)}→${JSON.stringify(now.first)} last ${JSON.stringify(now.last)} tail ${JSON.stringify(now.sourceTail)}`,
        );
      }
    }
    prevScroll = sign;
  }

  let lastRowReversals = 0;
  let prevRowSign = 0;
  for (let i = 1; i < frames.length; i++) {
    const delta = lastContentRow(frames[i]!.text) - lastContentRow(frames[i - 1]!.text);
    const sign = delta === 0 ? 0 : Math.sign(delta);
    if (sign === 0) continue;
    if (prevRowSign !== 0 && sign !== prevRowSign) lastRowReversals++;
    prevRowSign = sign;
  }

  let topLineReversals = 0;
  let previous = "";
  let prior = "";
  for (const frame of frames) {
    if (frame.first === previous) continue;
    if (prior && frame.first === prior) topLineReversals++;
    prior = previous;
    previous = frame.first;
  }

  let undone = 0;
  for (let i = 2; i < frames.length; i++) {
    if (frames[i]!.text === frames[i - 2]!.text && frames[i]!.text !== frames[i - 1]!.text) {
      undone++;
      if (examples.length < 8) {
        const changed = frames[i - 1]!;
        examples.push(
          `undone at ${i} restored ${JSON.stringify(frames[i]!.last)} after ${JSON.stringify(changed.last)} scroll ${frames[i - 2]!.scrollTop}/${frames[i - 1]!.scrollTop}/${frames[i]!.scrollTop} height ${frames[i - 2]!.scrollHeight}/${frames[i - 1]!.scrollHeight}/${frames[i]!.scrollHeight}`,
        );
      }
    }
  }

  return {
    bounce,
    scrollReversals,
    lastRowReversals,
    topLineReversals,
    undone,
    minScrollDelta,
    heightShrinks,
    markdownShrinks,
    rawSyntaxFrames: frames.filter((frame) => frame.rawSyntax.length > 0).length,
    rawSyntaxExamples: frames.flatMap((frame, index) => frame.rawSyntax.length > 0
      ? [`frame ${index} ${JSON.stringify(frame.rawSyntax)} tail ${JSON.stringify(frame.sourceTail)}`]
      : []).slice(0, 5),
    examples,
  };
}
