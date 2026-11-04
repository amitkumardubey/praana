import { describe, expect, it } from "bun:test";
import { parseStreamBatchMs, parseSynchronizedOutput } from "../src/ui/tui/render-options.js";

describe("parseSynchronizedOutput", () => {
  it("defaults to auto when unset or unknown", () => {
    expect(parseSynchronizedOutput(undefined)).toBe("auto");
    expect(parseSynchronizedOutput("banana")).toBe("auto");
    expect(parseSynchronizedOutput("")).toBe("auto");
  });

  it("accepts case-insensitive always/never", () => {
    expect(parseSynchronizedOutput("always")).toBe("always");
    expect(parseSynchronizedOutput("ALWAYS")).toBe("always");
    expect(parseSynchronizedOutput("Never")).toBe("never");
  });
});

describe("parseStreamBatchMs", () => {
  it("defaults to 0 (off) when unset", () => {
    expect(parseStreamBatchMs(undefined)).toBe(0);
  });

  it("parses valid integer milliseconds", () => {
    expect(parseStreamBatchMs("0")).toBe(0);
    expect(parseStreamBatchMs("1")).toBe(1);
    expect(parseStreamBatchMs("33")).toBe(33);
    expect(parseStreamBatchMs("250")).toBe(250);
  });

  it("treats invalid values as 0", () => {
    expect(parseStreamBatchMs("")).toBe(0);
    expect(parseStreamBatchMs("   ")).toBe(0);
    expect(parseStreamBatchMs("abc")).toBe(0);
    expect(parseStreamBatchMs("12.5")).toBe(0);
    expect(parseStreamBatchMs("1e3")).toBe(0);
    expect(parseStreamBatchMs("NaN")).toBe(0);
    expect(parseStreamBatchMs("Infinity")).toBe(0);
    expect(parseStreamBatchMs("0x10")).toBe(0);
    expect(parseStreamBatchMs("12 34")).toBe(0);
  });

  it("treats negative values as 0", () => {
    expect(parseStreamBatchMs("-1")).toBe(0);
    expect(parseStreamBatchMs("-250")).toBe(0);
  });

  it("caps huge values at 250", () => {
    expect(parseStreamBatchMs("251")).toBe(250);
    expect(parseStreamBatchMs("99999")).toBe(250);
    expect(parseStreamBatchMs("999999999999999999999")).toBe(250);
  });

  it("accepts surrounding whitespace", () => {
    expect(parseStreamBatchMs("  33 ")).toBe(33);
  });
});
