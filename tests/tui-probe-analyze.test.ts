import { describe, expect, test } from "bun:test";
import { analyzeSamples, finished } from "../scripts/tui-probe/analyze";
import { fixture } from "../scripts/tui-probe/mock-llm";

const lines = fixture.split("\n");
const frame = (...rows: string[]) => rows.join("\n");
const sequence = (...screens: string[]) => screens.map((text, i) => ({ timestamp: i * 100, text }));
const line = (s: string) => lines.find((x) => x.includes(s))!;
const a = line("Item 01:");
const b = line("Item 02:");
const c = line("Item 07:");
const d = line("Item 08:");

describe("TUI probe analyzer", () => {
  test("clean growing and scrolling stream without user message", () => {
    const r = analyzeSamples(sequence(frame(a), frame(a, b), frame(b, c), frame(c, d)), { height: 40 });
    expect([r.regressions, r.scrollReversals, r.aba, r.styleFlips]).toEqual([0, 0, 0, 0]);
    expect(r.samples[3]?.firstVisible).toBeGreaterThan(r.samples[0]!.firstVisible!);
    expect(r.unmatchedRatio).toBe(0);
  });
  test("detects regression", () => {
    expect(analyzeSamples(sequence(frame(a, b, c), frame(a, b)), { height: 40 }).regressions).toBe(1);
  });
  test("detects ABA text frames", () => {
    expect(analyzeSamples(sequence(frame(a), frame(b), frame(a)), { height: 40 }).aba).toBe(1);
  });
  test("detects viewport reversal with growing end", () => {
    expect(analyzeSamples(sequence(frame(b, c), frame(a, b, c, d)), { height: 40 }).scrollReversals).toBe(1);
  });
  test("detects returning bullet style", () => {
    const text = a.slice(2);
    const r = analyzeSamples(sequence(`\x1b[2m•\x1b[0m ${text}`, `\x1b[1m•\x1b[0m ${text}`, `\x1b[2m•\x1b[0m ${text}`), { height: 40 });
    expect(r.styleFlips).toBe(1);
  });
  test("matches incomplete markdown links during rendering", () => {
    const r = analyzeSamples(sequence("A bold claim, italic text, and inline code alongside", "A bold claim, italic text, and inline code alongside [a"), { height: 40 });
    expect(r.regressions).toBe(0);
    expect(r.unmatchedRatio).toBe(0);
  });
  test("matches the renderer's incomplete auto-linked URL", () => {
    const r = analyzeSamples(sequence("A bold claim, italic text, and inline code alongside [a link](https://ex (https://ex)"), { height: 40 });
    expect(r.unmatchedRatio).toBe(0);
    expect(r.samples[0]?.lastVisible).toBe(3);
    const wrapped = analyzeSamples(sequence("A bold claim, italic text, and inline code alongside [a link](https://example.com/a/ (https://example.com/\na/)"), { height: 40 });
    expect(wrapped.samples[0]?.lastVisible).toBe(3);
  });
  test("ignores table separator as decoration", () => {
    const r = analyzeSamples(sequence("| Name | Value | Notes |\n|------|-------|-------|"), { height: 40 });
    expect(r.samples[0]?.lastVisible).toBe(45);
    expect(r.unmatchedRatio).toBe(0);
  });
  test("inherits SGR state across rows without false flips", () => {
    const s = `\x1b[31m\n${a}`;
    const t = `\x1b[31m\n\x1b[31m${a}`;
    expect(analyzeSamples(sequence(s, t, s), { height: 40 }).styleFlips).toBe(0);
  });
  test("counts unmatched garbage", () => {
    expect(analyzeSamples(sequence(frame(a, "this is unrelated garbage")), { height: 40 }).unmatchedRatio).toBe(0.5);
  });
  test("detects finished prompt only without activity", () => {
    expect(finished("│ message praana │\n" )).toBe(true);
    expect(finished("replying…\n│ message praana │")).toBe(false);
    expect(finished("some other screen")).toBe(false);
  });
});
