import { describe, it, expect } from "vitest";
import { estimateTokens } from "../src/context-engine/summarize.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates Latin text at ~4 chars/token", () => {
    const text = "hello world"; // 11 chars
    const tokens = estimateTokens(text);
    // 11 chars / 4 = 2.75 → ceil = 3
    expect(tokens).toBe(3);
  });

  it("estimates longer Latin text correctly", () => {
    const text = "The quick brown fox jumps over the lazy dog"; // 43 chars
    const tokens = estimateTokens(text);
    // 43 / 4 = 10.75 → ceil = 11
    expect(tokens).toBe(11);
  });

  it("estimates CJK characters at ~1.5 chars/token", () => {
    // Chinese characters: 你好世界 (4 chars)
    const text = "你好世界";
    const tokens = estimateTokens(text);
    // 4 chars * 0.667 tokens/char = 2.668 → ceil = 3 tokens
    expect(tokens).toBe(3);
  });

  it("estimates Japanese hiragana at ~1.5 chars/token", () => {
    // Hiragana: こんにちは (5 chars)
    const text = "こんにちは";
    const tokens = estimateTokens(text);
    // 5 chars * 0.667 tokens/char = 3.335 → ceil = 4 tokens
    expect(tokens).toBe(4);
  });

  it("estimates Japanese katakana at ~1.5 chars/token", () => {
    // Katakana: カタカナ (4 chars)
    const text = "カタカナ";
    const tokens = estimateTokens(text);
    // 4 chars * 0.667 tokens/char = 2.668 → ceil = 3 tokens
    expect(tokens).toBe(3);
  });

  it("estimates Korean hangul at ~1.5 chars/token", () => {
    // Korean: 안녕하세요 (5 chars)
    const text = "안녕하세요";
    const tokens = estimateTokens(text);
    // 5 chars * 0.667 tokens/char = 3.335 → ceil = 4 tokens
    expect(tokens).toBe(4);
  });

  it("estimates emoji at ~1 char/token", () => {
    // Single emoji: 🎉 (1 char, but may be surrogate pair)
    const text = "🎉";
    const tokens = estimateTokens(text);
    // 1 emoji * 1 weight = 1 → ceil = 1
    expect(tokens).toBe(1);
  });

  it("estimates multiple emoji correctly", () => {
    const text = "🎉🚀✨"; // 3 emoji
    const tokens = estimateTokens(text);
    // 3 emoji * 1 weight = 3 → ceil = 3
    expect(tokens).toBe(3);
  });

  it("handles mixed Latin and CJK text", () => {
    // "Hello 你好 World 世界" - 5 Latin + 4 CJK + 4 spaces
    const text = "Hello 你好 World 世界";
    const tokens = estimateTokens(text);
    // Spaces count as Latin (4 chars/token)
    // H-e-l-l-o- - -W-o-r-l-d-  (12 chars * 4) + 你好世界 (4 * 1.5) = 48 + 6 = 54
    expect(tokens).toBeGreaterThan(0);
    // CJK portion should contribute more tokens per char than Latin
    expect(estimateTokens("你好世界")).toBeGreaterThan(estimateTokens("abcd"));
  });

  it("handles surrogate pairs (supplementary plane emoji)", () => {
    // Emoji with surrogate pair: 👨‍👩‍👧‍👦 (family emoji, multiple code points)
    const text = "👨‍👩‍👧‍👦";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(10); // Should be reasonable
  });

  it("CJK text produces more tokens than same-length Latin text", () => {
    const latinText = "abcd"; // 4 Latin chars
    const cjkText = "你好世界"; // 4 CJK chars
    // CJK should produce more tokens (1.5 chars/token vs 4 chars/token)
    expect(estimateTokens(cjkText)).toBeGreaterThan(estimateTokens(latinText));
  });
});
