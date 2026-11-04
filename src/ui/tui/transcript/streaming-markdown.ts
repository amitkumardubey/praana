/**
 * Keep a streaming markdown answer from gaining a row that the next paint
 * removes.
 *
 * OpenTUI's markdown code view paints a bare list marker, a trailing space on
 * a list item, or a trailing newline as an extra row on the streaming preview.
 * The highlight pass, or the next append, drops that row. Sticky-bottom scroll
 * follows both heights, so the transcript steps up a line and then back.
 *
 * While the answer is still streaming, drop those unfinished tails. A finished
 * answer is passed through unchanged. An open fence is left alone: its
 * trailing characters are code.
 */

const FENCE_LINE = /^(?:`{3,}|~{3,})/;
const INCOMPLETE_LIST_LINE = /(?:^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]*$/;
const LIST_ITEM_TRAILING_SPACE = /((?:^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S(?:.*\S)?)[ \t]+$/;

function unclosedFence(text: string): boolean {
  let open = false;
  for (const line of text.split("\n")) {
    if (FENCE_LINE.test(line)) open = !open;
  }
  return open;
}

export function stabilizeStreamingMarkdown(text: string): string {
  if (unclosedFence(text)) return text;
  let next = text;
  // A trailing newline can hide a bare marker (`-\n`). Strip, then look again.
  for (let pass = 0; pass < 3; pass++) {
    const stripped = next
      .replace(/\n+$/, "")
      .replace(INCOMPLETE_LIST_LINE, "")
      .replace(LIST_ITEM_TRAILING_SPACE, "$1");
    if (stripped === next) return next;
    next = stripped;
  }
  return next;
}
