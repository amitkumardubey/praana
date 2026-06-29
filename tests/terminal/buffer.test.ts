import { describe, it, expect } from "bun:test";
import { Buffer } from "../../src/terminal/core/buffer.js";
import { strWidth } from "../../src/terminal/core/text.js";

describe("Buffer", () => {
  it("should set and get cells", () => {
    const buf = Buffer.fromSize(10, 5);
    buf.setChar(2, 1, "X");
    expect(buf.get(2, 1).char).toBe("X");
  });

  it("should write strings with style", () => {
    const buf = Buffer.fromSize(20, 3);
    buf.setString(0, 0, "hello", { fg: "#ff0000" });
    expect(buf.get(0, 0).char).toBe("h");
    expect(buf.get(4, 0).char).toBe("o");
  });

  it("should fill a region", () => {
    const buf = Buffer.fromSize(5, 5);
    buf.fill({ x: 1, y: 1, width: 3, height: 3 }, "#");
    expect(buf.get(1, 1).char).toBe("#");
    expect(buf.get(0, 0).char).toBe(" ");
  });
});

describe("strWidth", () => {
  it("should count ASCII as width 1", () => {
    expect(strWidth("hello")).toBe(5);
  });

  it("should count CJK as width 2", () => {
    expect(strWidth("中文")).toBe(4);
  });
});
