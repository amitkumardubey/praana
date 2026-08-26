/** Plain-text wrap helpers for transcript components.
 * Wrapping is style-agnostic; callers apply SpanStyle via <span> once the
 * wrapped plain-text lines are known. */

/** Split text at width boundaries (word-wrap). Used for pre-splitting in
 *  tool-row bodies and similar. */
export function wrapContent(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

/** No-op passthrough; accent bars are handled by OpenTUI layout (zones disabled). */
export function renderAccentLines(
  lines: string[],
  _role: string,
  _zone: string,
  _showBorder: boolean,
  _width: number,
): string[] {
  return lines;
}
