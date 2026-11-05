import { describe, expect, it } from "bun:test";
import { parseSynchronizedOutput } from "../src/ui/tui/render-options.js";

describe("parseSynchronizedOutput", () => {
  it("defaults to auto when unset", () => {
    expect(parseSynchronizedOutput(undefined)).toBe("auto");
    expect(parseSynchronizedOutput("")).toBe("auto");
  });

  it("parses always case-insensitively", () => {
    expect(parseSynchronizedOutput("always")).toBe("always");
    expect(parseSynchronizedOutput("ALWAYS")).toBe("always");
    expect(parseSynchronizedOutput("Always")).toBe("always");
  });

  it("parses never case-insensitively", () => {
    expect(parseSynchronizedOutput("never")).toBe("never");
    expect(parseSynchronizedOutput("NEVER")).toBe("never");
    expect(parseSynchronizedOutput("Never")).toBe("never");
  });

  it("falls back to auto for anything else", () => {
    expect(parseSynchronizedOutput("true")).toBe("auto");
    expect(parseSynchronizedOutput("1")).toBe("auto");
    expect(parseSynchronizedOutput("synchronizedOutput")).toBe("auto");
    expect(parseSynchronizedOutput("  always  ")).toBe("auto");
    expect(parseSynchronizedOutput(" AUTO ")).toBe("auto");
    expect(parseSynchronizedOutput("AuTo")).toBe("auto");
  });
});
