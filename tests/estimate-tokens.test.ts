import { describe, it, expect } from "bun:test";
import { estimateTokens } from "../src/token-estimate.js";

describe("estimateTokens", () => {
  // ── Baseline ───────────────────────────────────────────────────────────────

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 0 for null-ish falsy value coerced to empty", () => {
    // The guard `if (!text)` must protect against empty string
    expect(estimateTokens("")).toBe(0);
  });

  // ── Latin / ASCII ──────────────────────────────────────────────────────────

  it("estimates Latin text at ~4 chars/token", () => {
    // "hello world" = 11 chars → 11 × 0.25 = 2.75 → ceil = 3
    expect(estimateTokens("hello world")).toBe(3);
  });

  it("estimates longer Latin text correctly", () => {
    // "The quick brown fox jumps over the lazy dog" = 43 chars
    // 43 × 0.25 = 10.75 → ceil = 11
    expect(estimateTokens("The quick brown fox jumps over the lazy dog")).toBe(11);
  });

  // ── CJK — Han ─────────────────────────────────────────────────────────────

  it("estimates CJK characters at ~1.5 chars/token", () => {
    // 你好世界 — 4 CJK Unified Ideographs
    // 4 × 0.667 = 2.668 → ceil = 3
    expect(estimateTokens("你好世界")).toBe(3);
  });

  it("CJK text produces more tokens than same-length Latin text", () => {
    // 4 CJK chars → 3 tokens; 4 Latin chars → 1 token
    expect(estimateTokens("你好世界")).toBeGreaterThan(estimateTokens("abcd"));
  });

  // ── CJK — Kana ────────────────────────────────────────────────────────────

  it("estimates Hiragana at ~1.5 chars/token", () => {
    // こんにちは — 5 Hiragana (U+3040–U+309F)
    // 5 × 0.667 = 3.335 → ceil = 4
    expect(estimateTokens("こんにちは")).toBe(4);
  });

  it("estimates Katakana at ~1.5 chars/token", () => {
    // カタカナ — 4 Katakana (U+30A0–U+30FF)
    // 4 × 0.667 = 2.668 → ceil = 3
    expect(estimateTokens("カタカナ")).toBe(3);
  });

  // ── CJK — Hangul ──────────────────────────────────────────────────────────

  it("estimates Korean Hangul at ~1.5 chars/token", () => {
    // 안녕하세요 — 5 Hangul syllables (U+AC00–U+D7AF)
    // 5 × 0.667 = 3.335 → ceil = 4
    expect(estimateTokens("안녕하세요")).toBe(4);
  });

  // ── CJK — ranges added in this fix ────────────────────────────────────────

  it("estimates CJK punctuation at CJK weight (。= U+3002)", () => {
    // 。is U+3002, inside CJK Symbols & Punctuation (U+3000–U+303F)
    // 1 × 0.667 = 0.667 → ceil = 1
    expect(estimateTokens("。")).toBe(1);
    // 4 CJK punctuation chars → 4 × 0.667 = 2.668 → ceil = 3
    expect(estimateTokens("。、「」")).toBe(3);
  });

  it("estimates fullwidth forms at CJK weight (Ａ = U+FF21)", () => {
    // Ａ is U+FF21, inside Fullwidth Forms (U+FF00–U+FFEF)
    // Common in Japanese text — should NOT be counted as Latin
    // 4 fullwidth chars → 4 × 0.667 = 2.668 → ceil = 3
    expect(estimateTokens("ＡＢＣＤ")).toBe(3);
    expect(estimateTokens("ＡＢＣＤ")).toBeGreaterThan(estimateTokens("ABCD"));
  });

  // ── Emoji ─────────────────────────────────────────────────────────────────

  it("estimates a single emoji at 1 token", () => {
    // 🎉 = U+1F389, inside main emoji block
    expect(estimateTokens("🎉")).toBe(1);
  });

  it("estimates multiple emoji correctly — including dingbats (✨ = U+2728)", () => {
    // 🎉 = U+1F389 (main emoji block)   → emoji weight
    // 🚀 = U+1F680 (main emoji block)   → emoji weight
    // ✨ = U+2728  (Misc Symbols block)  → emoji weight (previously counted as Latin)
    // 3 emoji × 1.0 = 3 → ceil = 3
    expect(estimateTokens("🎉🚀✨")).toBe(3);
  });

  it("estimates extended emoji at 1 token each (🪄 = U+1FA84)", () => {
    // U+1FA84 is in the Extended Symbols block (U+1FA00–U+1FAFF)
    // Previously missed by the old 0x1F000–0x1FFFF range
    expect(estimateTokens("🪄")).toBe(1);
    expect(estimateTokens("🪄🪄🪄")).toBe(3);
  });

  it("estimates misc symbol glyphs at emoji weight (★ = U+2605)", () => {
    // ★ = U+2605, in Misc Symbols (U+2600–U+27BF)
    // These are ~1 token each, not 0.25 (Latin)
    expect(estimateTokens("★")).toBe(1);
    expect(estimateTokens("★☀✓")).toBe(3);
  });

  // ── Combiners — zero token weight ─────────────────────────────────────────

  it("ZWJ (U+200D) contributes zero tokens in emoji sequences", () => {
    // 👨‍👩‍👧‍👦 = 👨 + ZWJ + 👩 + ZWJ + 👧 + ZWJ + 👦
    // 4 emoji × 1.0 + 3 ZWJ × 0 = 4 → ceil = 4
    // (Old code counted each ZWJ as Latin 0.25, giving ceil(4.75) = 5)
    expect(estimateTokens("👨‍👩‍👧‍👦")).toBe(4);
  });

  it("variation selectors (U+FE0F) contribute zero tokens", () => {
    // ☀️ = ☀ (U+2600) + variation selector-16 (U+FE0F)
    // Should count as 1 token (just the sun emoji), not 1.25
    expect(estimateTokens("☀️")).toBe(1);
    // Three emoji with variation selectors → 3 tokens
    expect(estimateTokens("☀️❄️🌊")).toBe(3);
  });

  // ── Mixed text ────────────────────────────────────────────────────────────

  it("handles mixed Latin and CJK text with exact token count", () => {
    // "Hello 你好 World 世界"
    //   H,e,l,l,o        = 5 Latin  → 5  × 0.25  = 1.25
    //   space            = 1 Latin  → 1  × 0.25  = 0.25
    //   你,好             = 2 CJK    → 2  × 0.667 = 1.334
    //   space            = 1 Latin  → 0.25
    //   W,o,r,l,d        = 5 Latin  → 5  × 0.25  = 1.25
    //   space            = 1 Latin  → 0.25
    //   世,界             = 2 CJK    → 2  × 0.667 = 1.334
    //   Total = 1.25 + 0.25 + 1.334 + 0.25 + 1.25 + 0.25 + 1.334 = 5.918 → ceil = 6
    expect(estimateTokens("Hello 你好 World 世界")).toBe(6);
  });
});
