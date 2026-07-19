// ============================================================
// PRAANA Memory — Loose JSON Parser
//
// Tolerant parser for LLM JSON responses. Handles common
// failure modes observed at session end:
//   - Code fences (```json ... ```)
//   - Leading/trailing prose around the JSON
//   - Truncated output (unterminated strings, missing braces)
// ============================================================

export interface LooseParseResult<T = unknown> {
  ok: boolean;
  value?: T;
  error?: string;
  /** true if a repair pass was needed to parse the input */
  repaired?: boolean;
}

/**
 * Parse an LLM JSON response tolerantly.
 *
 * Strategy (in order):
 * 1. Strip code fences (skipped if the input already starts with `{` or `[`).
 * 2. Direct JSON.parse.
 * 3. Extract balanced JSON candidates ({ ... } or [ ... ]) via brace scan
 *    and try each — handles leading/trailing prose, and prose that itself
 *    contains braces.
 * 4. Attempt repair for truncated JSON (unterminated strings, missing
 *    closing braces/brackets).
 * 5. Return { ok: false, error } if still failing.
 */
export function parseLooseJson<T = unknown>(raw: string): LooseParseResult<T> {
  if (typeof raw !== "string") {
    return { ok: false, error: "input is not a string" };
  }

  const text = stripCodeFences(raw).trim();
  if (text.length === 0) {
    return { ok: false, error: "empty input" };
  }

  // Step 1: direct parse
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    // continue to recovery
  }

  // Step 2: try each balanced candidate (handles prose containing braces)
  for (const candidate of extractBalancedJsonCandidates(text)) {
    try {
      return { ok: true, value: JSON.parse(candidate) as T };
    } catch {
      // try next candidate
    }
  }

  // Step 3: repair truncated JSON (closing open strings/brackets)
  const repaired = repairTruncatedJson(text);
  if (repaired !== null) {
    try {
      return { ok: true, value: JSON.parse(repaired) as T, repaired: true };
    } catch {
      // fall through
    }
  }

  return {
    ok: false,
    error: `JSON parse failed (raw length: ${raw.length} bytes)`,
  };
}

/**
 * Strip ```json ... ``` or ``` ... ``` fences.
 * Also handles truncated fences (opening without closing).
 *
 * Skipped when the trimmed input already starts with `{` or `[` — a ``` inside
 * a JSON string value would otherwise match the truncated-fence regex and
 * corrupt otherwise-valid JSON.
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return text;
  }

  // Complete fence
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/);
  if (fenced && fenced[1]) return fenced[1];

  // Truncated fence (opening without closing — common when LLM output is cut off)
  const openFence = text.match(/```(?:json)?\s*\n([\s\S]*)/);
  if (openFence && openFence[1]) return openFence[1];

  return text;
}

/** Find the index of the first { or [ in the text. */
function findJsonStart(text: string): number {
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  if (brace === -1) return bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

/**
 * Extract all balanced JSON candidates ({ ... } or [ ... ]) from the text,
 * in order of appearance. Useful when leading prose contains braces —
 * e.g. `Here { is prose } then {"real":"json"}` yields both `{ is prose }`
 * and `{"real":"json"}`, so the caller can try each and pick the one that
 * parses.
 */
function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = findJsonStart(text.slice(searchFrom));
    if (start === -1) break;

    const absStart = searchFrom + start;
    const stack: string[] = [];
    let inString = false;
    let escape = false;
    let end = -1;

    for (let i = absStart; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;

      if (ch === "{" || ch === "[") {
        stack.push(ch);
      } else if (ch === "}" || ch === "]") {
        stack.pop();
        if (stack.length === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) {
      // No balanced structure from this start — further starts are likely
      // inside a truncated outer structure. Fall through to repair.
      break;
    }
    candidates.push(text.slice(absStart, end + 1));
    searchFrom = end + 1;
  }

  return candidates;
}

/**
 * Attempt to repair truncated JSON by closing open strings and braces/brackets.
 * Handles the most common LLM truncation symptom: unterminated string literal.
 * Also strips trailing commas that would make the repaired JSON invalid.
 */
function repairTruncatedJson(text: string): string | null {
  const start = findJsonStart(text);
  if (start === -1) return null;

  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if ((ch === "}" || ch === "]") && stack.length > 0) {
      stack.pop();
    }
  }

  let repaired = text.slice(start);

  // Close open string
  if (inString) {
    repaired += '"';
  }

  // Strip trailing whitespace and commas
  repaired = repaired.replace(/[\s,]+$/, "");

  // Close open brackets in reverse order
  while (stack.length > 0) {
    const open = stack.pop()!;
    repaired += open === "{" ? "}" : "]";
  }

  return repaired;
}
