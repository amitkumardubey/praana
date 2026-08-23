import { describe, expect, it } from "bun:test";
import { checkSyntax } from "../src/verify/syntax.js";

describe("checkSyntax", () => {
  it("returns native_unavailable when parseFile is missing", async () => {
    const result = await checkSyntax("/tmp/a.ts", { parseFile: null });
    expect(result).toEqual({
      diagnostics: [],
      skipped: "native_unavailable",
    });
  });

  it("caps diagnostics at 20", async () => {
    const result = await checkSyntax("/tmp/a.ts", {
      parseFile: () => ({
        ok: true,
        diagnostics: Array.from({ length: 25 }, (_, i) => ({
          message: `e${i}`,
          startLine: i + 1,
          startCol: 1,
          endLine: i + 1,
          endCol: 2,
        })),
      }),
    });
    expect(result.diagnostics).toHaveLength(20);
    expect(result.skipped).toBeUndefined();
  });

  it("soft-fails parse errors as skipped", async () => {
    const result = await checkSyntax("/tmp/a.ts", {
      parseFile: () => ({
        ok: false,
        error: "boom",
        diagnostics: [],
      }),
    });
    expect(result.skipped).toBe("parse_error");
    expect(result.diagnostics).toEqual([]);
  });
});
