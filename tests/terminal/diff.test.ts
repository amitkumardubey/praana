import { describe, it, expect } from "bun:test";
import { Buffer } from "../../src/terminal/core/buffer.js";
import { diffBuffers } from "../../src/terminal/render/diff.js";

describe("diffBuffers", () => {
  it("should report all cells changed on first draw", () => {
    const buf = Buffer.fromSize(5, 2);
    buf.setString(0, 0, "hi");
    const result = diffBuffers(null, buf);
    expect(result.changedCells).toBe(10);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it("should report zero changes for identical buffers", () => {
    const a = Buffer.fromSize(5, 2);
    a.setString(0, 0, "hi");
    const b = a.clone();
    const result = diffBuffers(a, b);
    expect(result.changedCells).toBe(0);
  });

  it("should detect single cell change", () => {
    const a = Buffer.fromSize(5, 2);
    a.setString(0, 0, "hi");
    const b = a.clone();
    b.setChar(2, 0, "!");
    const result = diffBuffers(a, b);
    expect(result.changedCells).toBe(1);
  });
});
