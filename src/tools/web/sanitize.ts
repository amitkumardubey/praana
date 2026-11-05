/**
 * Remove terminal control sequences from text web_fetch shows the model.
 * Keeps newline and tab. Other C0/C1 controls and ANSI/OSC sequences are dropped.
 */

const OSC = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\)/g;
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
const ESC_OTHER = /\u001b[ -/]*[@-~]/g;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f]/g;

export function sanitizeWebText(text: string): string {
  OSC.lastIndex = 0;
  CSI.lastIndex = 0;
  ESC_OTHER.lastIndex = 0;
  CONTROLS.lastIndex = 0;
  return text.replace(OSC, "").replace(CSI, "").replace(ESC_OTHER, "").replace(CONTROLS, "");
}

/** Sanitize every string in a JSON value. Numbers, booleans, and null stay. */
export function sanitizeWebJson(value: unknown): unknown {
  if (typeof value === "string") return sanitizeWebText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeWebJson(item));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[sanitizeWebText(key)] = sanitizeWebJson(item);
    }
    return out;
  }
  return value;
}
