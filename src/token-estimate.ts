/**
 * Unicode-aware token count heuristic.
 *
 * Provider- and model-agnostic: works without any tokenizer vocab or native deps.
 * Use for pre-flight budget / compaction decisions. For exact post-call accounting,
 * prefer the `usage` object returned by the provider response.
 *
 * Approximate chars-per-token ratios by script class:
 *   Latin / code / whitespace : ~4 chars/token  → 0.25 tokens/char
 *   CJK (Han, Kana, Hangul)   : ~1.5 chars/token → 0.667 tokens/char
 *   Emoji / pictographs        : ~1 char/token   → 1.0 tokens/char
 *   ZWJ / variation selectors  : 0 — combiners, not independent tokens
 */

const LATIN_WEIGHT = 0.25; // 1 / 4
const CJK_WEIGHT = 0.667; // 1 / 1.5
const EMOJI_WEIGHT = 1.0; // 1 / 1

/**
 * Returns true for CJK ideographs, kana, hangul, fullwidth forms, and CJK punctuation.
 * All of these tokenise at roughly 1 token per 1.5 characters in BPE-family tokenisers.
 */
function isCJK(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols & punctuation (。、「」…)
    (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
    (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xff00 && cp <= 0xffef) || // Fullwidth forms (Ａ–Ｚ, ０–９, etc.)
    (cp >= 0x20000 && cp <= 0x2fa1f) // CJK Extension B–F + Compatibility Supplement
  );
}

/**
 * Returns true for emoji, pictographs, and misc symbol blocks.
 * Covers standard emoji, dingbats, and extended emoji added in Unicode 13+.
 */
function isEmoji(cp: number): boolean {
  return (
    (cp >= 0x2600 && cp <= 0x27bf) || // Misc symbols & dingbats (★ ✓ ☀ ♠ etc.)
    (cp >= 0x1f000 && cp <= 0x1faff) || // Main emoji blocks (emoticons, transport, symbols, extended)
    (cp >= 0x1fb00 && cp <= 0x1fbff) // Symbols for Legacy Computing
  );
}

/**
 * Returns true for zero-width combiners that do not represent independent tokens.
 * These should be skipped entirely in the count.
 */
function isCombiner(cp: number): boolean {
  return (
    cp === 0x200d || // Zero-Width Joiner — glues emoji sequences (👨‍👩‍👧‍👦)
    (cp >= 0xfe00 && cp <= 0xfe0f) // Variation selectors — emoji presentation (☀️)
  );
}

/**
 * Estimate the number of tokens in `text`.
 *
 * Iterates by Unicode code point (surrogate-safe) and weights each character
 * by its script class. Returns ceil of the weighted sum.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (isCombiner(cp)) continue; // ZWJ / variation selectors carry no token weight
    if (isEmoji(cp)) tokens += EMOJI_WEIGHT;
    else if (isCJK(cp)) tokens += CJK_WEIGHT;
    else tokens += LATIN_WEIGHT;
  }
  return Math.ceil(tokens);
}
