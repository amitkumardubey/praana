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
 * 1. Strip code fences.
 * 2. Direct JSON.parse.
 * 3. Extract outermost balanced { ... } or [ ... ] via brace scan
 *    (skips leading/trailing prose).
 * 4. Attempt repair for truncated JSON (unterminated strings,
 *    missing closing braces/brackets).
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

  // Step 2: extract outermost balanced JSON
  const balanced = extractBalancedJson(text);
  if (balanced !== null) {
    try {
      return { ok: true, value: JSON.parse(balanced) as T };
    } catch {
      // continue to repair
    }
  }

  // Step 3: repair truncated JSON
  const candidate = balanced ?? text;
  const repaired = repairTruncatedJson(candidate);
  if (repaired !== null) {
    try {
      return { ok: true, value: JSON.parse(repaired) as T, repaired: true };
    } catch {
      // fall through
    }
  }

  // Step 4: try repairing the full text if balanced extraction failed
  if (balanced === null) {
    const repaired2 = repairTruncatedJson(text);
    if (repaired2 !== null) {
      try {
        return { ok: true, value: JSON.parse(repaired2) as T, repaired: true };
      } catch {
        // fall through
      }
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
 */
function stripCodeFences(text: string): string {
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
 * Extract the outermost balanced JSON value ({ ... } or [ ... ]).
 * Returns null if no balanced structure is found.
 * Correctly skips braces/brackets inside string literals.
 */
function extractBalancedJson(text: string): string | null {
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
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
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
