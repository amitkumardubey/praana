/**
 * Remove terminal control sequences from text web_fetch shows the model.
 * Keeps newline and tab. Other C0/C1 controls and ANSI/OSC sequences are dropped.
 *
 * One linear pass: an unterminated OSC/CSI consumes the rest of the text
 * (the terminal-faithful reading of an unfinished sequence), so no suffix
 * is ever rescanned and adversarial openers cannot cause quadratic work.
 */

/** Scan an OSC body from `from` (just past the opener) to its terminator. */
function consumeOsc(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0x07) return i + 1; // BEL
    if (text.charCodeAt(i) === 0x1b && text.charCodeAt(i + 1) === 0x5c) return i + 2; // ESC \
  }
  return text.length;
}

/** Scan a CSI body from `from` (just past `ESC [`) through its final byte. */
function consumeCsi(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code <= 0x3f) {
      i += 1; // parameter and intermediate bytes
      continue;
    }
    if (code >= 0x40 && code <= 0x7e) return i + 1; // final byte
    return i;
  }
  return i;
}

/** Scan `ESC` + intermediates + final byte from `from` (just past the ESC). */
function consumeEsc(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code <= 0x2f) {
      i += 1; // intermediates
      continue;
    }
    if (code >= 0x30 && code <= 0x7e) return i + 1; // final byte
    return i;
  }
  return i;
}

export function sanitizeWebText(text: string): string {
  const n = text.length;
  if (n === 0) return text;
  const parts: string[] = [];
  let start = 0;
  let i = 0;
  const flush = (end: number): void => {
    if (end > start) parts.push(text.slice(start, end));
  };

  while (i < n) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const next = i + 1 < n ? text.charCodeAt(i + 1) : -1;
      if (next === 0x5d) {
        flush(i);
        i = consumeOsc(text, i + 2);
        start = i;
        continue;
      }
      if (next === 0x5b) {
        flush(i);
        i = consumeCsi(text, i + 2);
        start = i;
        continue;
      }
      flush(i);
      i = consumeEsc(text, i + 1);
      start = i;
      continue;
    }
    if (code === 0x9d) {
      flush(i);
      i = consumeOsc(text, i + 1);
      start = i;
      continue;
    }
    if (code === 0x9b) {
      flush(i);
      i = consumeCsi(text, i + 1);
      start = i;
      continue;
    }
    if (code <= 0x08 || (code >= 0x0b && code <= 0x1f) || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      flush(i);
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  flush(n);
  return parts.join("");
}

/** Sanitize every string in a JSON value. Numbers, booleans, and null stay. */
export function sanitizeWebJson(value: unknown): unknown {
  if (typeof value === "string") return sanitizeWebText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeWebJson(item));
  if (value !== null && typeof value === "object") {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      out[sanitizeWebText(key)] = sanitizeWebJson(item);
    }
    return out;
  }
  return value;
}
